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
    private FrameListener frameListener;
    private StateListener stateListener;
    private Thread readerThread;

    public void connect(String host, int port, String username, String password,
                        FrameListener frameListener, StateListener stateListener) throws IOException {
        this.frameListener = frameListener;
        this.stateListener = stateListener;
        this.closed = false;

        socket = new Socket();
        socket.connect(new InetSocketAddress(host, port), 5000);
        socket.setTcpNoDelay(true);
        out = socket.getOutputStream();

        readerThread = new Thread(new Runnable() {
            @Override
            public void run() {
                readLoop();
            }
        }, "chat-local-client");
        readerThread.setDaemon(true);
        readerThread.start();

        // 登录
        Map<String, Object> data = Json.obj();
        data.put("username", username);
        data.put("password", password);
        send(Protocol.frame(Protocol.C2S_AUTH, data, "auth-1"));

        if (stateListener != null) stateListener.onStateChanged(true, null);
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
                if (frameListener != null) frameListener.onFrame(line);
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

    /** 发送一帧（内容为原始 JSON 文本） */
    public void send(String rawJson) {
        if (out == null || closed) return;
        try {
            synchronized (writeLock) {
                out.write((rawJson + "\n").getBytes("UTF-8"));
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
