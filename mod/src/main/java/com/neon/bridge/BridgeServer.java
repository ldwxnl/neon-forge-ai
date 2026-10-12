package com.neon.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.slf4j.Logger;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * 本地 TCP 桥：127.0.0.1:8765，换行分隔 JSON。
 * 本类只做「收发」，不碰游戏对象；动作交给 ActionExecutor（在主线程执行）。
 */
public class BridgeServer {
    private static final Gson GSON = new Gson();
    private final int port;
    private final Logger log;
    private final ActionExecutor executor;

    private volatile Socket client;
    private volatile BufferedWriter out;
    private volatile boolean running;
    private long lastStateAt = 0L;

    public BridgeServer(int port, Logger log, ActionExecutor executor) {
        this.port = port;
        this.log = log;
        this.executor = executor;
    }

    public void start() {
        running = true;
        Thread t = new Thread(this::acceptLoop, "neonbridge-accept");
        t.setDaemon(true);
        t.start();
    }

    private void acceptLoop() {
        try (ServerSocket ss = new ServerSocket()) {
            ss.setReuseAddress(true);
            ss.bind(new InetSocketAddress("127.0.0.1", port));
            while (running) {
                Socket s = ss.accept();
                s.setTcpNoDelay(true);
                this.client = s;
                this.out = new BufferedWriter(new OutputStreamWriter(s.getOutputStream(), StandardCharsets.UTF_8));
                log.info("[neonbridge] node connected");
                readLoop(s);
                log.info("[neonbridge] node disconnected");
                this.client = null;
                this.out = null;
            }
        } catch (IOException e) {
            log.warn("[neonbridge] server stopped: " + e.getMessage());
        }
    }

    private void readLoop(Socket s) {
        try (BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) {
                String l = line.trim();
                if (l.isEmpty()) continue;
                try {
                    JsonObject m = JsonParser.parseString(l).getAsJsonObject();
                    String type = m.has("t") ? m.get("t").getAsString() : "";
                    if ("pong".equals(type)) continue;
                    if ("ping".equals(type)) { sendRaw("{\"t\":\"pong\"}"); continue; }
                    if ("action".equals(type)) {
                        int id = m.has("id") ? m.get("id").getAsInt() : 0;
                        String name = m.has("name") ? m.get("name").getAsString() : "";
                        JsonObject args = (m.has("args") && m.get("args").isJsonObject())
                                ? m.getAsJsonObject("args") : new JsonObject();
                        this.executor.submit(id, name, args);
                    }
                } catch (Throwable e) {
                    log.warn("[neonbridge] bad message: " + e.getMessage());
                }
            }
        } catch (IOException ignored) {
        } finally {
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    public synchronized void sendRaw(String json) {
        BufferedWriter w = this.out;
        if (w == null) return;
        try {
            w.write(json);
            w.write('\n');
            w.flush();
        } catch (IOException e) {
            this.out = null;
        }
    }

    public synchronized void sendResult(int id, boolean ok, String detail) {
        JsonObject o = new JsonObject();
        o.addProperty("t", "result");
        o.addProperty("id", id);
        o.addProperty("ok", ok);
        o.addProperty("detail", detail == null ? "" : detail);
        sendRaw(GSON.toJson(o));
    }

    /** 客户端 tick 调用；最多 ~5Hz 推一次状态。 */
    public void pumpState(JsonObject state) {
        long now = System.currentTimeMillis();
        if (now - lastStateAt < 200L) return;
        lastStateAt = now;
        if (this.out == null) return;
        JsonObject env = new JsonObject();
        env.addProperty("t", "state");
        env.add("data", state);
        sendRaw(GSON.toJson(env));
    }

    public boolean hasClient() { return this.out != null; }

    public void stop() {
        running = false;
        try { if (client != null) client.close(); } catch (IOException ignored) { }
    }
}
