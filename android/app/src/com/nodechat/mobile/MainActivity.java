package com.nodechat.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.net.Uri;
import android.os.Looper;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.Map;

/**
 * 手机端主界面：WebView 承载聊天 UI，App 内同时跑着聊天服务端（ChatServerCore）。
 *
 * 数据流：
 *   JS(app.js) --AndroidBridge.send(json)--> LocalChatClient --TCP--> ChatServerCore
 *   ChatServerCore --TCP--> LocalChatClient --AndroidBridge.__onFrame(json)--> JS
 *
 * WebView 里无法直接开 TCP 套接字，因此由 Java 侧做桥接。
 */
public class MainActivity extends Activity {

    private static final String TAG = "node-chat";
    private static final String PREFS = "node_chat_store";
    private static final int FILE_CHOOSER_REQUEST = 0x1001;

    private WebView webView;
    private ChatServerCore server;
    private LocalChatClient client;
    private SharedPreferences prefs;
    private final Handler ui = new Handler(Looper.getMainLooper());
    /** WebView 文件选择器回调（用于 <input type="file"> 选择图片） */
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        startEmbeddedServer();

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择图片"), FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        webView.addJavascriptInterface(new JsBridge(), "AndroidBridge");
        setContentView(webView);
        webView.loadUrl("file:///android_asset/index.html");
    }

    /** 启动 App 内嵌的服务端 */
    private void startEmbeddedServer() {
        server = new ChatServerCore(ChatServerCore.DEFAULT_PORT, "node-chat-mobile");
        server.setPersistence(new ChatServerCore.Persistence() {
            @Override
            public void save(String key, String json) {
                prefs.edit().putString(key, json).apply();
            }

            @Override
            public String load(String key) {
                return prefs.getString(key, null);
            }
        });
        server.addListener(new ChatServerCore.Listener() {
            @Override
            public void onStatusChanged(ChatServerCore s) {
                pushServerInfo();
            }
        });
        try {
            server.start();
            Log.i(TAG, "内嵌服务端已启动，端口 " + server.getPort());
        } catch (Exception e) {
            Log.e(TAG, "内嵌服务端启动失败: " + e.getMessage());
        }
        // 预置一个演示群
        pushServerInfo();
    }

    // --------------------------------------------------------------- JS 桥
    private class JsBridge {

        /** 服务端信息（内置服务端地址、状态） */
        @JavascriptInterface
        public String serverInfo() {
            return Json.stringify(serverInfoMap());
        }

        /** 连接聊天服务端：host 为空表示连接 App 内置服务端 */
        @JavascriptInterface
        public void connect(String host, String port, String username, String password) {
            String targetHost = host == null || host.trim().isEmpty() ? "127.0.0.1" : host.trim();
            int targetPort;
            if (port == null || port.trim().isEmpty()) {
                targetPort = server != null ? server.getPort() : ChatServerCore.DEFAULT_PORT;
            } else {
                try {
                    targetPort = Integer.parseInt(port.trim());
                } catch (NumberFormatException e) {
                    targetPort = server != null ? server.getPort() : ChatServerCore.DEFAULT_PORT;
                }
            }
            final String h = targetHost;
            final int p = targetPort;

            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (client != null) client.close();
                        client = new LocalChatClient();
                        client.connect(h, p, username, password, new LocalChatClient.FrameListener() {
                            @Override
                            public void onFrame(String rawJson) {
                                pushFrame(rawJson);
                            }
                        }, new LocalChatClient.StateListener() {
                            @Override
                            public void onStateChanged(boolean connected, String error) {
                                pushStatus(connected, error);
                            }
                        });
                    } catch (Exception e) {
                        pushStatus(false, "连接失败: " + e.getMessage());
                    }
                }
            }, "chat-bridge-connect").start();
        }

        /** 发送一帧原始 JSON */
        @JavascriptInterface
        public void send(String rawJson) {
            if (client == null) return;
            client.send(rawJson);
        }

        @JavascriptInterface
        public void disconnect() {
            if (client != null) {
                client.close();
                client = null;
            }
            pushStatus(false, null);
        }

        /** 以管理员身份向所有在线用户广播公告（演示用） */
        @JavascriptInterface
        public void broadcast(String text) {
            if (server == null || text == null || text.trim().isEmpty()) return;
            server.broadcast(text.trim(), "管理员");
        }

        @JavascriptInterface
        public boolean isConnected() {
            return client != null && client.isConnected();
        }
    }

    // ------------------------------------------------------------ 推送到 JS
    private void pushFrame(final String rawJson) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                // 用 JSON.parse 包裹，避免任何内容被当作 JS 代码执行
                webView.evaluateJavascript(
                        "window.__onFrame && window.__onFrame(JSON.parse(" + Protocol.jsStringLiteral(rawJson) + "));",
                        null);
            }
        });
    }

    private void pushStatus(final boolean connected, final String error) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                String payload = Json.stringify(kv("connected", connected, "error", error));
                webView.evaluateJavascript(
                        "window.__onStatus && window.__onStatus(JSON.parse(" + Protocol.jsStringLiteral(payload) + "));",
                        null);
            }
        });
    }

    private void pushServerInfo() {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                String payload = Json.stringify(serverInfoMap());
                webView.evaluateJavascript(
                        "window.__onServerInfo && window.__onServerInfo(JSON.parse(" + Protocol.jsStringLiteral(payload) + "));",
                        null);
            }
        });
    }

    private Map<String, Object> serverInfoMap() {
        Map<String, Object> map = Json.obj();
        if (server != null) {
            map.put("running", server.isRunning());
            map.put("port", server.getPort());
            map.put("host", "127.0.0.1");
            map.put("name", server.getServerName());
            map.put("online", server.onlineCount());
        } else {
            map.put("running", false);
        }
        return map;
    }

    private static Map<String, Object> kv(Object... pairs) {
        Map<String, Object> map = Json.obj();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            map.put(String.valueOf(pairs[i]), pairs[i + 1]);
        }
        return map;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                    results = new Uri[] { data.getData() };
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ------------------------------------------------------------- 生命周期
    @Override
    protected void onDestroy() {
        if (client != null) client.close();
        if (server != null) server.stop();
        super.onDestroy();
    }
}
