package com.nodechat.mobile;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 内嵌在 App 里的聊天服务端（纯 Java，不依赖任何 Android API，可在桌面 JVM 上直接跑）。
 *
 * - 监听 127.0.0.1，协议与 Node 版 node-chat 完全一致（NDJSON over TCP）
 * - 支持：认证、群聊、私聊、离线信箱、历史消息、在线状态、系统公告
 * - 通过 adb forward 可让 PC 上的 chat-cli 直接连上手机里的这个服务端
 */
public class ChatServerCore {

    public static final int DEFAULT_PORT = 9099;

    /** 可选的持久化接口（Android 端用 SharedPreferences 实现，桌面测试用内存实现） */
    public interface Persistence {
        void save(String key, String json);

        String load(String key);
    }

    /** 服务端状态监听（供 UI 展示在线人数等） */
    public interface Listener {
        void onStatusChanged(ChatServerCore server);
    }

    private final Object lock = new Object();
    private final int requestedPort;
    private final String serverName;

    private ServerSocket serverSocket;
    private volatile boolean running = false;
    private int actualPort = -1;

    /** username -> Session */
    private final Map<String, Session> sessions = new LinkedHashMap<>();
    /** 群名 -> 群 */
    private final Map<String, Room> rooms = new LinkedHashMap<>();
    /** dmKey -> 消息列表 */
    private final Map<String, List<Map<String, Object>>> dmHistory = new LinkedHashMap<>();
    /** username -> 离线期间的私聊（信箱） */
    private final Map<String, List<Map<String, Object>>> pendingInbox = new LinkedHashMap<>();
    /** username -> password（demo 版明文保存在内存/本地偏好，Node 版用 scrypt 哈希） */
    private final Map<String, String> accounts = new LinkedHashMap<>();
    /** username -> 头像（data URL） */
    private final Map<String, String> avatars = new LinkedHashMap<>();

    private final List<Listener> listeners = new CopyOnWriteArrayList<>();
    private Persistence persistence;
    private Thread acceptThread;

    public ChatServerCore() {
        this(DEFAULT_PORT, "node-chat-mobile");
    }

    public ChatServerCore(int port, String serverName) {
        this.requestedPort = port;
        this.serverName = serverName == null ? "node-chat-mobile" : serverName;
    }

    // ------------------------------------------------------------- 生命周期
    public void setPersistence(Persistence persistence) {
        this.persistence = persistence;
    }

    public void addListener(Listener listener) {
        if (listener != null) listeners.add(listener);
    }

    public void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    /** 启动服务端（阻塞返回后已在后台接受连接） */
    public void start() throws IOException {
        if (running) return;
        loadPersisted();
        seedDefaultRooms();

        serverSocket = new ServerSocket(requestedPort, 50, InetAddress.getByName("127.0.0.1"));
        actualPort = serverSocket.getLocalPort();
        running = true;

        acceptThread = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop();
            }
        }, "chat-server-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    public void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
        }
        List<Session> copy;
        synchronized (lock) {
            copy = new ArrayList<>(sessions.values());
        }
        for (Session s : copy) s.close();
        synchronized (lock) {
            sessions.clear();
        }
        saveAll();
    }

    public boolean isRunning() {
        return running;
    }

    public int getPort() {
        return actualPort;
    }

    public String getServerName() {
        return serverName;
    }

    private void acceptLoop() {
        while (running) {
            try {
                final Socket socket = serverSocket.accept();
                final Session session = new Session(socket);
                Thread t = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        handleSession(session);
                    }
                }, "chat-client-" + session.id);
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                if (running) {
                    // 单个连接异常不影响整体，继续接受
                    continue;
                }
                return;
            }
        }
    }

    // --------------------------------------------------------------- 连接处理
    private void handleSession(Session session) {
        try {
            send(session, Protocol.frame(Protocol.S2C_SYSTEM, kv("event", "welcome", "server", serverName,
                    "version", Protocol.VERSION, "port", actualPort), null));
            // 用 BufferedReader 按行读取：
            //  1) InputStreamReader 会跨分块保留 UTF-8 状态，中文不会被截断成乱码
            //  2) 读满一整行再判断长度，超长帧不会留下残尾被当成新帧解析
            java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(session.in, "UTF-8"), 8192);
            String line;
            while (running && !session.closed && (line = reader.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;
                if (line.length() > Protocol.MAX_LINE) {
                    send(session, Protocol.frame(Protocol.S2C_ERROR,
                            kv("code", Protocol.ERR_BAD_REQUEST,
                                    "message", "消息过长（上限 " + (Protocol.MAX_LINE / 1024) + "KB）"), null));
                    continue;
                }
                try {
                    Map<String, Object> frame = Json.parseObject(line);
                    dispatch(session, frame);
                } catch (Exception e) {
                    send(session, Protocol.frame(Protocol.S2C_ERROR,
                            kv("code", Protocol.ERR_BAD_REQUEST, "message", "报文解析失败: " + e.getMessage()), null));
                }
            }
        } catch (IOException ignored) {
            // 连接断开
        } finally {
            onClose(session);
        }
    }

    private void dispatch(Session session, Map<String, Object> frame) {
        String type = Json.getStr(frame, "type");
        Map<String, Object> data = Json.getMap(frame, "data");
        if (data == null) data = Json.obj();
        String id = Json.getStr(frame, "id");

        if (type == null) {
            send(session, Protocol.frame(Protocol.S2C_ERROR,
                    kv("code", Protocol.ERR_BAD_REQUEST, "message", "缺少 type 字段"), null));
            return;
        }
        if (Protocol.C2S_AUTH.equals(type)) {
            handleAuth(session, data, id);
            return;
        }
        if (Protocol.C2S_PING.equals(type)) {
            send(session, Protocol.frame(Protocol.S2C_PONG, kv("at", System.currentTimeMillis()), null));
            return;
        }
        if (session.user == null) {
            send(session, Protocol.frame(Protocol.S2C_ERROR,
                    kv("code", Protocol.ERR_UNAUTHORIZED, "message", "请先认证（auth）"), id));
            return;
        }

        if (Protocol.C2S_MSG.equals(type)) {
            handlePrivateMessage(session, data, id);
        } else if (Protocol.C2S_GROUP.equals(type)) {
            handleGroupMessage(session, data, id);
        } else if (Protocol.C2S_JOIN.equals(type)) {
            handleJoin(session, data, id);
        } else if (Protocol.C2S_LEAVE.equals(type)) {
            handleLeave(session, data, id);
        } else if (Protocol.C2S_ROOMS.equals(type)) {
            send(session, Protocol.frame(Protocol.S2C_ROOMS, kv("rooms", listRooms()), id));
        } else if (Protocol.C2S_MEMBERS.equals(type)) {
            handleMembers(session, data, id);
        } else if (Protocol.C2S_WHO.equals(type)) {
            send(session, Protocol.frame(Protocol.S2C_WHO,
                    kv("users", onlineUsers(), "avatars", avatarMap()), id));
        } else if (Protocol.C2S_HISTORY.equals(type)) {
            handleHistory(session, data, id);
        } else if (Protocol.C2S_PROFILE.equals(type)) {
            handleProfile(session, data, id);
        } else if (Protocol.C2S_QUIT.equals(type)) {
            session.close();
        } else {
            send(session, Protocol.frame(Protocol.S2C_ERROR,
                    kv("code", Protocol.ERR_BAD_REQUEST, "message", "未知类型: " + type), id));
        }
    }

    // ------------------------------------------------------------------ 认证
    private void handleAuth(Session session, Map<String, Object> data, String id) {
        String username = Json.getStr(data, "username");
        String password = Json.getStr(data, "password");

        if (!Protocol.isValidUsername(username) || password == null || password.isEmpty()) {
            authFail(session, "用户名或密码格式不正确", id);
            return;
        }
        synchronized (lock) {
            String known = accounts.get(username);
            if (known != null && !known.equals(password)) {
                authFail(session, "密码错误", id);
                return;
            }
            if (sessions.containsKey(username)) {
                authFail(session, "用户 " + username + " 已在别处登录", id);
                return;
            }
            if (known == null) {
                accounts.put(username, password);
            }
            session.user = username;
            sessions.put(username, session);
        }
        saveAccounts();

        send(session, Protocol.frame(Protocol.S2C_AUTH_OK,
                kv("user", username, "rooms", listRooms(), "server", serverName,
                        "avatar", getAvatar(username)), id));
        broadcastPresence(username, true);
        broadcastSystem(kv("event", "user_joined", "user", username, "at", System.currentTimeMillis()), username);
        notifyListeners();
        flushInbox(session);
    }

    private void authFail(Session session, String message, String id) {
        send(session, Protocol.frame(Protocol.S2C_AUTH_ERR, kv("message", message), id));
        session.close();
    }

    private void flushInbox(Session session) {
        List<Map<String, Object>> offline;
        synchronized (lock) {
            offline = pendingInbox.remove(session.user);
        }
        if (offline == null) return;
        for (Map<String, Object> message : offline) {
            Map<String, Object> payload = new LinkedHashMap<>(message);
            payload.put("offline", Boolean.TRUE);
            send(session, Protocol.frame(Protocol.S2C_MSG, payload, null));
        }
    }

    // ------------------------------------------------------------------ 私聊
    private void handlePrivateMessage(Session session, Map<String, Object> data, String id) {
        String to = Json.getStr(data, "to");
        String text = Json.getStr(data, "text", "");
        String image = Json.getStr(data, "image");
        if (!Protocol.isValidUsername(to)) {
            error(session, Protocol.ERR_BAD_REQUEST, "收件人用户名非法", id);
            return;
        }
        if (!Protocol.isValidText(text) && image == null) {
            error(session, Protocol.ERR_BAD_REQUEST, "消息内容长度需在 1~" + Protocol.MAX_TEXT + " 之间", id);
            return;
        }
        if (image != null && !Protocol.isValidImageDataUrl(image)) {
            error(session, Protocol.ERR_BAD_REQUEST, "图片格式非法或超过大小限制", id);
            return;
        }
        if (to.equals(session.user)) {
            error(session, Protocol.ERR_BAD_REQUEST, "不能给自己发私聊", id);
            return;
        }

        Map<String, Object> message = kv("id", "m" + System.currentTimeMillis(),
                "from", session.user, "to", to, "text", text, "ts", System.currentTimeMillis());
        if (image != null) message.put("image", image);
        Session target;
        synchronized (lock) {
            appendDmHistory(session.user, to, message);
            target = sessions.get(to);
            if (target == null) {
                List<Map<String, Object>> inbox = pendingInbox.get(to);
                if (inbox == null) {
                    inbox = new ArrayList<>();
                    pendingInbox.put(to, inbox);
                }
                inbox.add(message);
            }
        }
        saveDmHistory();

        if (target != null) {
            send(target, Protocol.frame(Protocol.S2C_MSG, message, null));
            send(session, Protocol.frame(Protocol.S2C_ACK,
                    kv("ok", Boolean.TRUE, "kind", "msg", "message", message,
                            "delivered", Boolean.TRUE), id));
        } else {
            send(session, Protocol.frame(Protocol.S2C_ACK,
                    kv("ok", Boolean.TRUE, "kind", "msg", "message", message,
                            "delivered", Boolean.FALSE, "note", "对方离线，消息已存入信箱"), id));
        }
    }

    // ------------------------------------------------------------------ 群聊
    private void handleGroupMessage(Session session, Map<String, Object> data, String id) {
        String room = Json.getStr(data, "room");
        String text = Json.getStr(data, "text", "");
        String image = Json.getStr(data, "image");
        if (!Protocol.isValidRoomName(room)) {
            error(session, Protocol.ERR_BAD_REQUEST, "群名称非法", id);
            return;
        }
        if (!Protocol.isValidText(text) && image == null) {
            error(session, Protocol.ERR_BAD_REQUEST, "消息内容长度需在 1~" + Protocol.MAX_TEXT + " 之间", id);
            return;
        }
        if (image != null && !Protocol.isValidImageDataUrl(image)) {
            error(session, Protocol.ERR_BAD_REQUEST, "图片格式非法或超过大小限制", id);
            return;
        }
        if (!isMember(room, session.user)) {
            error(session, Protocol.ERR_NOT_IN_ROOM, "你还不是群「" + room + "」的成员，请先 join", id);
            return;
        }

        Map<String, Object> message = kv("id", "g" + System.currentTimeMillis(),
                "room", room, "from", session.user, "text", text, "ts", System.currentTimeMillis());
        if (image != null) message.put("image", image);
        List<Session> targets;
        synchronized (lock) {
            Room r = ensureRoom(room);
            r.history.add(message);
            trim(r.history);
            stripOldImages(r.history);
            targets = new ArrayList<>();
            for (String member : r.members) {
                Session s = sessions.get(member);
                if (s != null) targets.add(s);
            }
        }
        saveRooms();

        for (Session s : targets) {
            send(s, Protocol.frame(Protocol.S2C_GROUP, message, null));
        }
        send(session, Protocol.frame(Protocol.S2C_ACK,
                kv("ok", Boolean.TRUE, "kind", "group", "message", message), id));
    }

    private void handleJoin(Session session, Map<String, Object> data, String id) {
        String room = Json.getStr(data, "room");
        if (!Protocol.isValidRoomName(room)) {
            error(session, Protocol.ERR_BAD_REQUEST, "群名称非法", id);
            return;
        }
        List<String> members;
        boolean created;
        synchronized (lock) {
            created = !rooms.containsKey(room);
            Room r = ensureRoom(room);
            if (!r.members.contains(session.user)) r.members.add(session.user);
            members = new ArrayList<>(r.members);
            session.rooms.add(room);
        }
        saveRooms();

        send(session, Protocol.frame(Protocol.S2C_JOIN_OK,
                kv("room", room, "created", created, "members", members), id));
        for (String member : members) {
            if (member.equals(session.user)) continue;
            Session s = sessionOf(member);
            if (s != null) {
                send(s, Protocol.frame(Protocol.S2C_SYSTEM,
                        kv("event", "member_joined", "user", session.user, "room", room), null));
            }
        }
        notifyListeners();
    }

    private void handleLeave(Session session, Map<String, Object> data, String id) {
        String room = Json.getStr(data, "room");
        if (!Protocol.isValidRoomName(room)) {
            error(session, Protocol.ERR_BAD_REQUEST, "群名称非法", id);
            return;
        }
        List<String> members;
        synchronized (lock) {
            Room r = rooms.get(room);
            members = r == null ? new ArrayList<String>() : new ArrayList<>(r.members);
            if (r != null) {
                r.members.remove(session.user);
            }
            session.rooms.remove(room);
        }
        saveRooms();
        send(session, Protocol.frame(Protocol.S2C_LEAVE_OK, kv("room", room, "ok", true), id));
        for (String member : members) {
            Session s = sessionOf(member);
            if (s != null) {
                send(s, Protocol.frame(Protocol.S2C_SYSTEM,
                        kv("event", "member_left", "user", session.user, "room", room), null));
            }
        }
        notifyListeners();
    }

    private void handleMembers(Session session, Map<String, Object> data, String id) {
        String room = Json.getStr(data, "room");
        if (!Protocol.isValidRoomName(room)) {
            error(session, Protocol.ERR_BAD_REQUEST, "群名称非法", id);
            return;
        }
        List<String> members;
        boolean exists;
        synchronized (lock) {
            Room r = rooms.get(room);
            exists = r != null;
            members = r == null ? new ArrayList<String>() : new ArrayList<>(r.members);
        }
        send(session, Protocol.frame(Protocol.S2C_MEMBERS,
                kv("room", room, "members", members, "exists", exists), id));
    }

    /** 资料：设置或查询头像 */
    private void handleProfile(Session session, Map<String, Object> data, String id) {
        String action = Json.getStr(data, "action");
        if (action == null) {
            action = data.containsKey("avatar") ? "set" : "get";
        }
        if ("set".equals(action)) {
            String avatar = Json.getStr(data, "avatar");
            if (!Protocol.isValidAvatarDataUrl(avatar)) {
                error(session, Protocol.ERR_BAD_REQUEST, "头像格式非法或超过大小限制", id);
                return;
            }
            synchronized (lock) {
                avatars.put(session.user, avatar);
            }
            saveAvatars();
            send(session, Protocol.frame(Protocol.S2C_PROFILE,
                    kv("user", session.user, "avatar", avatar), id));
            // 广播给所有在线客户端，便于实时刷新头像
            broadcastSystem(kv("event", "avatar", "user", session.user, "avatar", avatar,
                    "at", System.currentTimeMillis()), session.user);
            return;
        }
        if ("get".equals(action)) {
            String user = Json.getStr(data, "user");
            if (user == null) user = session.user;
            if (!Protocol.isValidUsername(user)) {
                error(session, Protocol.ERR_BAD_REQUEST, "用户名非法", id);
                return;
            }
            send(session, Protocol.frame(Protocol.S2C_PROFILE,
                    kv("user", user, "avatar", getAvatar(user)), id));
            return;
        }
        error(session, Protocol.ERR_BAD_REQUEST, "未知 action: " + action, id);
    }

    private void handleHistory(Session session, Map<String, Object> data, String id) {
        int limit = Json.getInt(data, "limit", 50);
        String room = Json.getStr(data, "room");
        String to = Json.getStr(data, "to");
        if (room != null) {
            if (!Protocol.isValidRoomName(room)) {
                error(session, Protocol.ERR_BAD_REQUEST, "群名称非法", id);
                return;
            }
            List<Map<String, Object>> history;
            synchronized (lock) {
                Room r = rooms.get(room);
                history = r == null ? new ArrayList<Map<String, Object>>() : tail(r.history, limit);
            }
            send(session, Protocol.frame(Protocol.S2C_HISTORY,
                    kv("scope", "room", "room", room, "messages", history), id));
            return;
        }
        if (to != null) {
            if (!Protocol.isValidUsername(to)) {
                error(session, Protocol.ERR_BAD_REQUEST, "用户名非法", id);
                return;
            }
            List<Map<String, Object>> history;
            synchronized (lock) {
                history = tail(dmHistory.get(Protocol.dmKey(session.user, to)), limit);
            }
            send(session, Protocol.frame(Protocol.S2C_HISTORY,
                    kv("scope", "dm", "with", to, "messages", history), id));
            return;
        }
        error(session, Protocol.ERR_BAD_REQUEST, "history 需要指定 room 或 to", id);
    }

    // ------------------------------------------------------------------ 工具
    private void onClose(Session session) {
        session.closed = true;
        String user = session.user;
        if (user == null) return;
        synchronized (lock) {
            Session current = sessions.get(user);
            if (current == session) sessions.remove(user);
        }
        broadcastPresence(user, false);
        broadcastSystem(kv("event", "user_left", "user", user, "at", System.currentTimeMillis()), user);
        notifyListeners();
    }

    private Session sessionOf(String username) {
        synchronized (lock) {
            return sessions.get(username);
        }
    }

    private boolean isMember(String room, String user) {
        synchronized (lock) {
            Room r = rooms.get(room);
            return r != null && r.members.contains(user);
        }
    }

    private Room ensureRoom(String name) {
        Room r = rooms.get(name);
        if (r == null) {
            r = new Room(name);
            rooms.put(name, r);
        }
        return r;
    }

    /** 首次启动预置两个公共群，避免新用户面对空白列表 */
    private void seedDefaultRooms() {
        synchronized (lock) {
            if (!rooms.isEmpty()) return;
            for (String name : new String[]{"大厅", "闲聊"}) {
                Room r = new Room(name);
                r.createdBy = "系统";
                rooms.put(name, r);
            }
            saveRooms();
        }
    }

    /** 向所有在线用户广播一条系统公告 */
    public void broadcast(String text, String from) {
        Map<String, Object> message = kv("id", "s" + System.currentTimeMillis(),
                "room", null, "from", from == null ? "系统" : from,
                "text", text, "ts", System.currentTimeMillis(), "system", true);
        Map<String, Object> payload = new LinkedHashMap<>(message);
        payload.put("event", "announcement");
        List<Session> targets;
        synchronized (lock) {
            targets = new ArrayList<>(sessions.values());
        }
        for (Session s : targets) {
            send(s, Protocol.frame(Protocol.S2C_SYSTEM, payload, null));
        }
    }

    public void broadcast(String text) {
        broadcast(text, "系统");
    }

    public List<Object> listRooms() {
        List<Object> list = new ArrayList<>();
        synchronized (lock) {
            for (Room r : rooms.values()) {
                Map<String, Object> item = kv("name", r.name, "createdAt", r.createdAt,
                        "createdBy", r.createdBy, "memberCount", r.members.size());
                list.add(item);
            }
        }
        Collections.sort(list, new java.util.Comparator<Object>() {
            @Override
            public int compare(Object a, Object b) {
                return Json.getStr(Json.asObject(a), "name").compareTo(Json.getStr(Json.asObject(b), "name"));
            }
        });
        return list;
    }

    /** 读取某个用户的头像 */
    public String getAvatar(String username) {
        synchronized (lock) {
            return avatars.get(username);
        }
    }

    /** 全部已设置头像的用户 -> data URL */
    public Map<String, Object> avatarMap() {
        Map<String, Object> map = new LinkedHashMap<>();
        synchronized (lock) {
            for (Map.Entry<String, String> e : avatars.entrySet()) {
                map.put(e.getKey(), e.getValue());
            }
        }
        return map;
    }

    public List<String> onlineUsers() {
        synchronized (lock) {
            List<String> users = new ArrayList<>(sessions.keySet());
            Collections.sort(users);
            return users;
        }
    }

    public int onlineCount() {
        synchronized (lock) {
            return sessions.size();
        }
    }

    private void broadcastPresence(String username, boolean online) {
        Map<String, Object> payload = kv("user", username, "online", online, "at", System.currentTimeMillis());
        broadcastToAll(Protocol.S2C_PRESENCE, payload, null);
    }

    private void broadcastSystem(Map<String, Object> payload, String exceptUser) {
        broadcastToAll(Protocol.S2C_SYSTEM, payload, exceptUser);
    }

    private void broadcastToAll(String type, Map<String, Object> payload, String exceptUser) {
        List<Session> targets;
        synchronized (lock) {
            targets = new ArrayList<>();
            for (Map.Entry<String, Session> e : sessions.entrySet()) {
                if (exceptUser != null && exceptUser.equals(e.getKey())) continue;
                targets.add(e.getValue());
            }
        }
        for (Session s : targets) {
            send(s, Protocol.frame(type, payload, null));
        }
    }

    private void error(Session session, String code, String message, String id) {
        send(session, Protocol.frame(Protocol.S2C_ERROR, kv("code", code, "message", message), id));
    }

    private void send(Session session, String line) {
        if (session == null || session.closed) return;
        try {
            synchronized (session.out) {
                session.out.write((line + "\n").getBytes("UTF-8"));
                session.out.flush();
            }
        } catch (IOException ignored) {
            session.closed = true;
        }
    }

    private void notifyListeners() {
        for (Listener l : listeners) {
            try {
                l.onStatusChanged(this);
            } catch (Exception ignored) {
            }
        }
    }

    private void appendDmHistory(String from, String to, Map<String, Object> message) {
        String key = Protocol.dmKey(from, to);
        List<Map<String, Object>> list = dmHistory.get(key);
        if (list == null) {
            list = new ArrayList<>();
            dmHistory.put(key, list);
        }
        list.add(message);
        trim(list);
        stripOldImages(list);
    }

    private static void trim(List<Map<String, Object>> list) {
        while (list.size() > Protocol.HISTORY_KEEP) {
            list.remove(0);
        }
    }

    /** 历史里只保留最近 IMAGE_HISTORY_KEEP 条消息的图片，避免存储无限膨胀 */
    private static void stripOldImages(List<Map<String, Object>> list) {
        int boundary = list.size() - Protocol.IMAGE_HISTORY_KEEP;
        for (int i = 0; i < boundary; i++) {
            if (list.get(i) != null) list.get(i).remove("image");
        }
    }

    private static List<Map<String, Object>> tail(List<Map<String, Object>> list, int limit) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (list == null || list.isEmpty()) return out;
        int n = Math.max(1, Math.min(limit, Protocol.MAX_HISTORY));
        int from = Math.max(0, list.size() - n);
        for (int i = from; i < list.size(); i++) out.add(list.get(i));
        return out;
    }

    /** 构造一个保持插入顺序的 map（kv 可变参数） */
    private static Map<String, Object> kv(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            map.put(String.valueOf(pairs[i]), pairs[i + 1]);
        }
        return map;
    }

    // ------------------------------------------------------------- 持久化
    private void loadPersisted() {
        if (persistence == null) return;
        try {
            String raw = persistence.load("accounts");
            if (raw != null && !raw.isEmpty()) {
                Map<String, Object> obj = Json.parseObject(raw);
                accounts.clear();
                for (Map.Entry<String, Object> e : obj.entrySet()) {
                    accounts.put(e.getKey(), String.valueOf(e.getValue()));
                }
            }
            String rawAvatars = persistence.load("avatars");
            if (rawAvatars != null && !rawAvatars.isEmpty()) {
                Map<String, Object> obj = Json.parseObject(rawAvatars);
                avatars.clear();
                for (Map.Entry<String, Object> e : obj.entrySet()) {
                    avatars.put(e.getKey(), String.valueOf(e.getValue()));
                }
            }
            String rawRooms = persistence.load("rooms");
            if (rawRooms != null && !rawRooms.isEmpty()) {
                Map<String, Object> obj = Json.parseObject(rawRooms);
                rooms.clear();
                for (Map.Entry<String, Object> e : obj.entrySet()) {
                    Room r = new Room(e.getKey());
                    Map<String, Object> roomObj = Json.asObject(e.getValue());
                    if (roomObj != null) {
                        r.createdAt = Json.getLong(roomObj, "createdAt", System.currentTimeMillis());
                        r.createdBy = Json.getStr(roomObj, "createdBy");
                        List<Object> members = Json.asArray(roomObj.get("members"));
                        if (members != null) {
                            for (Object m : members) r.members.add(String.valueOf(m));
                        }
                        List<Object> history = Json.asArray(roomObj.get("history"));
                        if (history != null) {
                            for (Object m : history) {
                                Map<String, Object> mo = Json.asObject(m);
                                if (mo != null) r.history.add(mo);
                            }
                        }
                    }
                    rooms.put(r.name, r);
                }
            }
        } catch (Exception ignored) {
            // 持久化数据损坏时忽略，使用空状态启动
        }
    }

    private void saveAccounts() {
        if (persistence == null) return;
        try {
            persistence.save("accounts", Json.stringify(accounts));
        } catch (Exception ignored) {
        }
    }

    private void saveRooms() {
        if (persistence == null) return;
        try {
            Map<String, Object> map = new LinkedHashMap<>();
            synchronized (lock) {
                for (Room r : rooms.values()) {
                    map.put(r.name, kv("createdAt", r.createdAt, "createdBy", r.createdBy,
                            "members", new ArrayList<String>(r.members),
                            "history", new ArrayList<Map<String, Object>>(r.history)));
                }
            }
            persistence.save("rooms", Json.stringify(map));
        } catch (Exception ignored) {
        }
    }

    private void saveDmHistory() {
        if (persistence == null) return;
        try {
            Map<String, Object> map = new LinkedHashMap<>();
            synchronized (lock) {
                for (Map.Entry<String, List<Map<String, Object>>> e : dmHistory.entrySet()) {
                    map.put(e.getKey(), new ArrayList<Map<String, Object>>(e.getValue()));
                }
            }
            persistence.save("dms", Json.stringify(map));
        } catch (Exception ignored) {
        }
    }

    private void saveAvatars() {
        if (persistence == null) return;
        try {
            Map<String, Object> map = new LinkedHashMap<>();
            synchronized (lock) {
                for (Map.Entry<String, String> e : avatars.entrySet()) {
                    map.put(e.getKey(), e.getValue());
                }
            }
            persistence.save("avatars", Json.stringify(map));
        } catch (Exception ignored) {
        }
    }

    private void saveAll() {
        saveAccounts();
        saveRooms();
        saveDmHistory();
        saveAvatars();
    }

    // ------------------------------------------------------------------ 内部类
    private static final class Room {
        final String name;
        long createdAt = System.currentTimeMillis();
        String createdBy;
        final Set<String> members = new LinkedHashSet<>();
        final List<Map<String, Object>> history = new ArrayList<>();

        Room(String name) {
            this.name = name;
        }
    }

    private static final class Session {
        static int counter = 0;
        final int id;
        final Socket socket;
        final BufferedInputStream in;
        final OutputStream out;
        String user;
        final Set<String> rooms = new LinkedHashSet<>();
        volatile boolean closed = false;

        Session(Socket socket) throws IOException {
            this.id = ++counter;
            this.socket = socket;
            this.in = new BufferedInputStream(socket.getInputStream());
            this.out = socket.getOutputStream();
            this.socket.setTcpNoDelay(true);
        }

        void close() {
            closed = true;
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }
}
