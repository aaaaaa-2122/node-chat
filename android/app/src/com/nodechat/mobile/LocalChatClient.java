package com.nodechat.mobile;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Map;

/**
 * 内嵌客户端：App 内 WebView 通过它与聊天服务端通信（纯 Java，无 Android 依赖）。
 *
 * 负责把 WebView 里的 JS 帧原样写入 socket，并把服务端返回的每一行原样回抛给 JS。
 */
public class LocalChatClient {

    /** 收到一帧（原始 JSON 文本） */
    public interface FrameListener {
        void onFrame(String rawJson);
    }

    /** 连接状态变化 */
    public interface StateListener {
        void onStateChanged(boolean connected, String error);
    }

    private final Object writeLock = new Object();
    private Socket socket;
    private OutputStream out;
    private volatile boolean closed = false;
    private Secure.Channel channel; // 强制加密
    private FrameListener frameListener;
    private StateListener stateListener;
    private Thread readerThread;

    public void connectRaw(String host, int port,
                        FrameListener frameListener, StateListener stateListener) throws IOException {
        this.frameListener = frameListener;
        this.stateListener = stateListener;
        this.closed = false;

        socket = new Socket();
        socket.connect(new InetSocketAddress(host, port), 5000);
        socket.setTcpNoDelay(true);
        out = socket.getOutputStream();

        // 强制加密：读线程启动前同步做 secure 握手
        try { secureHandshake(); }
        catch (Exception e) { closed = true; throw new IOException("加密握手失败: " + e.getMessage()); }

        readerThread = new Thread(new Runnable() {
            @Override
            public void run() {
                readLoop();
            }
        }, "chat-local-client");
        readerThread.setDaemon(true);
        readerThread.start();

        if (stateListener != null) stateListener.onStateChanged(true, null);
    }

    /** 强制加密：连接后同步握手（读线程尚未启动） */
    /** 连接并认证（普通登录） */
    public void connect(String host, int port, String username, String password,
                        FrameListener frameListener, StateListener stateListener) throws IOException {
        connectRaw(host, port, frameListener, stateListener);
        Map<String, Object> data = Json.obj();
        data.put("username", username);
        data.put("password", password);
        send(Protocol.frame(Protocol.C2S_AUTH, data, "auth-1"));
    }
    private void secureHandshake() throws Exception {
        Secure.Key key = Secure.generateX25519();
        java.util.Map<String, Object> d = Json.obj();
        d.put("v", 1);
        d.put("cpub", android.util.Base64.encodeToString(key.pub, android.util.Base64.NO_WRAP));
        synchronized (writeLock) { out.write((Protocol.frame(Protocol.C2S_SECURE, d, null) + "\n").getBytes("UTF-8")); out.flush(); }
        java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream(), "UTF-8"));
        String line = r.readLine();
        if (line == null) throw new IOException("服务端在握手阶段关闭连接");
        java.util.Map<String, Object> f = Json.asObject(Json.parse(line));
        String type = Json.getStr(f, "type");
        java.util.Map<String, Object> data = Json.asObject(f.get("data"));
        if (Protocol.S2C_SECURE_ERR.equals(type)) throw new IOException("加密握手被拒: " + Json.getStr(data, "message"));
        if (!Protocol.S2C_SECURE_OK.equals(type)) throw new IOException("握手应答异常: " + type);
        byte[] spub = android.util.Base64.decode(Json.getStr(data, "spub"), android.util.Base64.NO_WRAP);
        byte[] shared = Secure.x25519(key.priv, spub);
        byte[] salt = Secure.sha256(concatBytes(key.pub, spub));
        byte[] c2s = Secure.hkdfSha256(shared, salt, "nodechat-c2s".getBytes("UTF-8"));
        byte[] s2c = Secure.hkdfSha256(shared, salt, "nodechat-s2c".getBytes("UTF-8"));
        channel = new Secure.Channel(c2s, s2c, 0);
    }

    private void readLoop() {
        try {
            // InputStreamReader 跨分块保留 UTF-8 状态，中文不会被截断
            java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(socket.getInputStream(), "UTF-8"), 8192);
            String line;
            while (!closed && (line = reader.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;
                if (frameListener != null) frameListener.onFrame(channel == null ? line : channel.open(line));
            }
        } catch (IOException ignored) {
            // 连接断开
        } finally {
            if (!closed) {
                closed = true;
                if (stateListener != null) stateListener.onStateChanged(false, "连接已断开");
            }
        }
    }

    private static byte[] concatBytes(byte[] a, byte[] b) { byte[] o = new byte[a.length+b.length]; System.arraycopy(a,0,o,0,a.length); System.arraycopy(b,0,o,a.length,b.length); return o; }
    /** 发送一帧（内容为原始 JSON 文本） */
    public void send(String rawJson) {
        if (out == null || closed) return;
        try {
            synchronized (writeLock) {
                out.write(((channel == null ? rawJson : channel.seal(rawJson)) + "\n").getBytes("UTF-8"));
                out.flush();
            }
        } catch (IOException e) {
            closed = true;
            if (stateListener != null) stateListener.onStateChanged(false, e.getMessage());
        }
    }

    public boolean isConnected() {
        return out != null && !closed && socket != null && socket.isConnected() && !socket.isClosed();
    }

    public void close() {
        closed = true;
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
        }
        out = null;
    }
}
