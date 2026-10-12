package com.neon.bridge;

import com.mojang.logging.LogUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.DeathScreen;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraftforge.client.event.ClientChatReceivedEvent;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;
import org.slf4j.Logger;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * neonbridge —— 一个「只做手脚、不做决策」的客户端桥。
 *
 * 它把本地玩家状态推给本机的 Node AI（TCP 127.0.0.1:8765），
 * 并执行 Node 发来的原语指令。所有游戏访问都发生在客户端主线程。
 *
 * 可选自主能力（由 gameDir/neonbridge.json 控制）：
 *   { "server": "localhost:25565", "autoConnect": true, "autoRespawn": true }
 *   - autoRespawn：死亡界面自动重生（默认 true）
 *   - autoConnect：在标题/断线界面自动连回 server（默认 false）
 */
@Mod(NeonBridge.MODID)
public class NeonBridge {
    public static final String MODID = "neonbridge";
    private static final Logger LOGGER = LogUtils.getLogger();
    private static NeonBridge INSTANCE;

    private final BridgeServer server;
    private final StateCollector collector;
    private final ActionExecutor executor;

    // 配置
    private String autoServer = null;
    private boolean autoConnect = false;
    private boolean autoRespawn = true;
    private long lastConnectAttempt = 0L;

    public NeonBridge(FMLJavaModLoadingContext context) {
        INSTANCE = this;
        this.collector = new StateCollector();
        this.executor = new ActionExecutor(LOGGER, null);
        this.server = new BridgeServer(8765, LOGGER, this.executor);
        this.executor.setServer(this.server);

        try { loadConfig(); } catch (Throwable t) { LOGGER.warn("[neonbridge] config load failed: " + t.getMessage()); }

        MinecraftForge.EVENT_BUS.register(this);
        this.server.start();
        LOGGER.info("[neonbridge] listening on 127.0.0.1:8765 (autoRespawn=" + autoRespawn + ", autoConnect=" + autoConnect + ")");
    }

    private void loadConfig() throws java.io.IOException {
        Path p = Minecraft.getInstance().gameDirectory.toPath().resolve("neonbridge.json");
        if (!Files.isRegularFile(p)) return;
        JsonObject o = JsonParser.parseString(Files.readString(p)).getAsJsonObject();
        if (o.has("server")) autoServer = o.get("server").getAsString();
        if (o.has("autoConnect")) autoConnect = o.get("autoConnect").getAsBoolean();
        if (o.has("autoRespawn")) autoRespawn = o.get("autoRespawn").getAsBoolean();
    }

    public static NeonBridge get() { return INSTANCE; }
    public BridgeServer server() { return server; }
    public StateCollector collector() { return collector; }
    public ActionExecutor executor() { return executor; }

    @SubscribeEvent
    public void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END) return;
        try {
            this.executor.tick();
            this.server.pumpState(this.collector.collect());

            Minecraft mc = Minecraft.getInstance();

            // 自主重生：停在死亡界面时自动复活
            if (autoRespawn && mc.player != null && mc.screen instanceof DeathScreen) {
                mc.player.respawn();
                LOGGER.info("[neonbridge] auto-respawn");
            }

            // 自主进入游戏 / 断线自动重连（需要在 neonbridge.json 里配 server + autoConnect=true）
            if (autoConnect && autoServer != null && !autoServer.isEmpty()) {
                boolean atMenu = mc.screen instanceof TitleScreen || mc.screen instanceof DisconnectedScreen;
                if (atMenu && mc.level == null && System.currentTimeMillis() - lastConnectAttempt > 8000L) {
                    lastConnectAttempt = System.currentTimeMillis();
                    ServerData sd = new ServerData("neonbridge", autoServer, false);
                    ConnectScreen.startConnecting(mc.screen, mc, ServerAddress.parseString(autoServer), sd, false);
                    LOGGER.info("[neonbridge] auto-connecting to " + autoServer);
                }
            }
        } catch (Throwable t) {
            LOGGER.warn("[neonbridge] tick error: " + t.getMessage());
        }
    }

    @SubscribeEvent
    public void onChat(ClientChatReceivedEvent event) {
        try {
            this.collector.pushChat(event.getMessage().getString());
        } catch (Throwable ignored) {
        }
    }
}
