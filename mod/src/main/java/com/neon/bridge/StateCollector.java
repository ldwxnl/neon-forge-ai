package com.neon.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;

import java.util.ArrayDeque;
import java.util.Deque;

/**
 * 把本地客户端「能看到的一切」收集成 state JSON 发给 Node。
 * 这里不做任何决策，只做感知（眼睛）。
 */
public class StateCollector {

    private final Deque<JsonObject> chat = new ArrayDeque<>();
    private JsonObject lastScan = null;
    private long lastScanAt = 0L;
    private double lastScanX = 0, lastScanZ = 0;

    public void pushChat(String text) {
        JsonObject o = new JsonObject();
        String user = "";
        String msg = text == null ? "" : text;
        if (msg.startsWith("<")) {
            int end = msg.indexOf('>');
            if (end > 1) { user = msg.substring(1, end).trim(); msg = msg.substring(end + 1).trim(); }
        }
        o.addProperty("user", user);
        o.addProperty("msg", msg);
        // 不推送"自己说的话"（客户端会收到自己聊天的回显），避免 AI 把自己的话当成别人的
        try {
            var selfPl = net.minecraft.client.Minecraft.getInstance().player;
            if (selfPl != null && !user.isEmpty() && user.equals(selfPl.getGameProfile().getName())) return;
        } catch (Throwable ignored) { }
        synchronized (chat) {
            chat.addLast(o);
            while (chat.size() > 40) chat.removeFirst();
        }
    }

    private static String itemName(ItemStack st) {
        if (st == null || st.isEmpty()) return "";
        return BuiltInRegistries.ITEM.getKey(st.getItem()).toString();
    }

    private static String blockName(BlockState st) {
        if (st == null) return "air";
        return BuiltInRegistries.BLOCK.getKey(st.getBlock()).toString();
    }

    private static String entityName(Entity e) {
        return BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString();
    }

    private static JsonObject stackJson(ItemStack st) {
        JsonObject o = new JsonObject();
        if (st == null || st.isEmpty()) {
            o.addProperty("name", "");
            o.addProperty("count", 0);
        } else {
            o.addProperty("name", itemName(st));
            o.addProperty("count", st.getCount());
        }
        return o;
    }

    public JsonObject collect() {
        JsonObject s = new JsonObject();
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer p = mc.player;
        if (p == null || mc.level == null) {
            s.addProperty("ready", false);
            return s;
        }
        s.addProperty("ready", true);

        BlockPos bp = p.blockPosition();

        JsonObject pos = new JsonObject();
        pos.addProperty("x", p.getX());
        pos.addProperty("y", p.getY());
        pos.addProperty("z", p.getZ());
        s.add("pos", pos);

        s.addProperty("yaw", p.getYRot());
        s.addProperty("pitch", p.getXRot());
        s.addProperty("health", p.getHealth());
        s.addProperty("maxHealth", p.getMaxHealth());
        s.addProperty("food", p.getFoodData().getFoodLevel());
        s.addProperty("oxygen", p.getAirSupply());
        s.addProperty("xpLevel", p.experienceLevel);
        s.addProperty("onGround", p.onGround());
        s.addProperty("inWater", p.isInWater());
        s.addProperty("onFire", p.isOnFire());
        s.addProperty("sprinting", p.isSprinting());
        s.addProperty("sneaking", p.isShiftKeyDown());
        s.addProperty("dead", p.isDeadOrDying());
        s.addProperty("sleeping", p.isSleeping());
        s.addProperty("dimension", mc.level.dimension().location().toString());
        s.addProperty("timeOfDay", mc.level.getDayTime() % 24000L);
        s.addProperty("raining", mc.level.isRaining());
        s.addProperty("thundering", mc.level.isThundering());
        s.addProperty("gamemode", mc.gameMode != null ? mc.gameMode.getPlayerMode().getName() : "?");
        try { s.addProperty("self", p.getGameProfile().getName()); } catch (Throwable ignored) { }
        try { s.addProperty("flying", p.getAbilities().flying); } catch (Throwable ignored) { }
        try { s.addProperty("creative", mc.gameMode != null && mc.gameMode.getPlayerMode().isCreative()); } catch (Throwable ignored) { }

        // 生物群系 / 光照
        s.addProperty("biome",
                mc.level.getBiome(bp).unwrapKey().map(k -> k.location().toString()).orElse("?"));
        try { s.addProperty("light", mc.level.getMaxLocalRawBrightness(bp)); } catch (Throwable ignored) { }

        // 脚下 / 身体所在方块
        s.addProperty("feet", blockName(mc.level.getBlockState(bp)));
        s.addProperty("under", blockName(mc.level.getBlockState(bp.below())));

        // 手持
        JsonObject held = stackJson(p.getMainHandItem());
        s.add("held", held);

        // 护甲
        JsonObject armor = new JsonObject();
        armor.add("head", stackJson(p.getItemBySlot(EquipmentSlot.HEAD)));
        armor.add("chest", stackJson(p.getItemBySlot(EquipmentSlot.CHEST)));
        armor.add("legs", stackJson(p.getItemBySlot(EquipmentSlot.LEGS)));
        armor.add("feet", stackJson(p.getItemBySlot(EquipmentSlot.FEET)));
        s.add("armor", armor);

        // 状态效果
        JsonArray effects = new JsonArray();
        try {
            for (MobEffectInstance mi : p.getActiveEffects()) {
                JsonObject e = new JsonObject();
                e.addProperty("name", BuiltInRegistries.MOB_EFFECT.getKey(mi.getEffect()).toString());
                e.addProperty("amplifier", mi.getAmplifier());
                e.addProperty("duration", mi.getDuration());
                effects.add(e);
            }
        } catch (Throwable ignored) { }
        s.add("effects", effects);

        // 准星正对着什么（左键=挖/攻击，右键=使用/放置）
        JsonObject la = new JsonObject();
        HitResult hr = mc.hitResult;
        if (hr instanceof BlockHitResult bhr) {
            BlockPos t = bhr.getBlockPos();
            la.addProperty("type", "block");
            la.addProperty("name", blockName(mc.level.getBlockState(t)));
            la.addProperty("x", t.getX());
            la.addProperty("y", t.getY());
            la.addProperty("z", t.getZ());
        } else if (hr instanceof EntityHitResult ehr) {
            Entity e = ehr.getEntity();
            la.addProperty("type", "entity");
            la.addProperty("name", entityName(e));
            la.addProperty("x", e.getX());
            la.addProperty("y", e.getY());
            la.addProperty("z", e.getZ());
            la.addProperty("dist", Math.sqrt(e.distanceToSqr(p)));
        } else {
            la.addProperty("type", "none");
        }
        s.add("lookingAt", la);

        // 载具 / 打开的界面
        Entity veh = p.getVehicle();
        s.addProperty("vehicle", veh != null ? entityName(veh) : "");
        s.addProperty("screen", mc.screen != null ? mc.screen.getClass().getSimpleName() : "none");

        // 背包（含槽号）
        JsonArray inv = new JsonArray();
        for (ItemStack st : p.getInventory().items) {
            if (st == null || st.isEmpty()) continue;
            JsonObject o = new JsonObject();
            o.addProperty("name", itemName(st));
            o.addProperty("count", st.getCount());
            o.addProperty("slot", p.getInventory().items.indexOf(st));
            inv.add(o);
        }
        s.add("inventory", inv);

        // 附近玩家
        JsonArray players = new JsonArray();
        try {
            for (var pl : mc.level.players()) {
                if (pl == p) continue;
                JsonObject o = new JsonObject();
                o.addProperty("name", pl.getGameProfile().getName());
                o.addProperty("x", pl.getX());
                o.addProperty("y", pl.getY());
                o.addProperty("z", pl.getZ());
                o.addProperty("dist", Math.sqrt(pl.distanceToSqr(p)));
                players.add(o);
            }
        } catch (Throwable ignored) { }
        s.add("players", players);

        // 附近实体
        JsonArray ents = new JsonArray();
        try {
            for (Entity e : mc.level.entitiesForRendering()) {
                if (e == p) continue;
                double d = Math.sqrt(e.distanceToSqr(p));
                if (d > 32) continue;
                JsonObject o = new JsonObject();
                o.addProperty("name", e instanceof net.minecraft.world.entity.player.Player pl ? pl.getGameProfile().getName() : entityName(e));
                o.addProperty("type", e.getType().getCategory().getName());
                o.addProperty("x", e.getX());
                o.addProperty("y", e.getY());
                o.addProperty("z", e.getZ());
                o.addProperty("dist", d);
                ents.add(o);
            }
        } catch (Throwable ignored) { }
        s.add("entities", ents);

        // 大范围扫描（~48 格 ≈ 12 区块）：方块分布 + 生物清单（2 秒或移动 8 格刷新一次，避免每 tick 重算）
        long nowMs = System.currentTimeMillis();
        if (lastScan == null || nowMs - lastScanAt > 2000
                || Math.abs(p.getX() - lastScanX) + Math.abs(p.getZ() - lastScanZ) > 8) {
            lastScan = scanAround(mc, p);
            lastScanAt = nowMs; lastScanX = p.getX(); lastScanZ = p.getZ();
        }
        s.add("scan", lastScan);

        // 聊天
        JsonArray chatArr = new JsonArray();
        synchronized (chat) {
            for (JsonObject c : chat) chatArr.add(c);
        }
        s.add("chat", chatArr);

        return s;
    }

    /** 大范围扫描：玩家周围 R 格内的方块类型统计 + 生物清单（只感知，不决策）。 */
    private JsonObject scanAround(Minecraft mc, LocalPlayer p) {
        JsonObject out = new JsonObject();
        BlockPos c = p.blockPosition();
        final int R = 48;

        java.util.Map<String, Integer> tally = new java.util.HashMap<>();
        for (int dx = -R; dx <= R; dx += 6) {
            for (int dz = -R; dz <= R; dz += 6) {
                for (int dy = -12; dy <= 12; dy += 3) {
                    BlockPos q = c.offset(dx, dy, dz);
                    try {
                        if (!mc.level.isLoaded(q)) continue;
                        BlockState st = mc.level.getBlockState(q);
                        if (st.isAir()) continue;
                        tally.merge(blockName(st), 1, Integer::sum);
                    } catch (Throwable ignored) { }
                }
            }
        }
        java.util.List<java.util.Map.Entry<String, Integer>> top = new java.util.ArrayList<>(tally.entrySet());
        top.sort((a, b) -> b.getValue() - a.getValue());
        JsonArray blocks = new JsonArray();
        for (int i = 0; i < Math.min(14, top.size()); i++) {
            JsonObject o = new JsonObject();
            o.addProperty("name", top.get(i).getKey());
            o.addProperty("count", top.get(i).getValue());
            blocks.add(o);
        }
        out.add("blocks", blocks);

        JsonArray mobs = new JsonArray();
        try {
            for (Entity e : mc.level.entitiesForRendering()) {
                if (e == p) continue;
                double d = Math.sqrt(e.distanceToSqr(p));
                if (d > R) continue;
                String cat = e.getType().getCategory().getName();
                if ("misc".equals(cat)) continue; // 跳过掉落物等杂项
                JsonObject o = new JsonObject();
                o.addProperty("name", e instanceof net.minecraft.world.entity.player.Player pl ? pl.getGameProfile().getName() : entityName(e));
                o.addProperty("type", cat);
                o.addProperty("x", e.getX());
                o.addProperty("y", e.getY());
                o.addProperty("z", e.getZ());
                o.addProperty("dist", Math.round(d * 10) / 10.0);
                mobs.add(o);
            }
        } catch (Throwable ignored) { }
        out.add("mobs", mobs);

        // 水 / 岩浆 / 容器 概览（让 AI 一眼知道危险与资源）
        int water = tally.getOrDefault("minecraft:water", 0);
        int lava = tally.getOrDefault("minecraft:lava", 0);
        int containers = 0;
        for (java.util.Map.Entry<String, Integer> en : tally.entrySet()) {
            String n = en.getKey();
            if (n.endsWith("_chest") || n.endsWith(":barrel") || n.endsWith("_shulker_box")
                    || n.endsWith(":furnace") || n.endsWith(":crafting_table")) {
                containers += en.getValue();
            }
        }
        out.addProperty("water", water);
        out.addProperty("lava", lava);
        out.addProperty("containers", containers);

        out.addProperty("radius", R);
        return out;
    }
}
