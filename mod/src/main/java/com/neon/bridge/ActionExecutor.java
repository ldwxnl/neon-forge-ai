package com.neon.bridge;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

/**
 * ActionExecutor —— 只做「手脚」。接收 Node 发来的 action，在主线程执行，
 * 多 tick 动作通过 per-tick Task 状态机推进。不含任何决策逻辑。
 */
public class ActionExecutor {

    private final Logger log;
    private BridgeServer server;

    // 当前正在执行的多 tick 动作
    private Task task;
    private int taskId = -1;

    public ActionExecutor(Logger log, BridgeServer server) {
        this.log = log;
        this.server = server;
    }

    /** 打断与 BridgeServer 的循环依赖：先建 executor(server=null)，再回填。 */
    public void setServer(BridgeServer server) {
        this.server = server;
    }

    // ---------------- 入口 ----------------
    public void submit(int id, String name, JsonObject args) {
        Minecraft mc = Minecraft.getInstance();
        mc.execute(() -> {
            try {
                dispatch(id, name, args == null ? new JsonObject() : args, mc);
            } catch (Throwable t) {
                log.warn("[neonbridge] action {} 异常: {}", name, t.toString());
                send(id, false, "执行异常: " + t.getMessage());
            }
        });
    }

    private void dispatch(int id, String name, JsonObject a, Minecraft mc) {
        LocalPlayer p = mc.player;
        if (p == null || mc.level == null) { send(id, false, "客户端尚未进入世界"); return; }

        switch (name) {
            // ---- 立即动作 ----
            case "chat":        chat(id, mc, str(a, "message", "")); return;
            case "whisper":     whisper(id, mc, str(a, "player", ""), str(a, "message", "")); return;
            case "look_at":     lookAt(id, mc, num(a, "x"), num(a, "y"), num(a, "z")); return;
            case "look_at_entity": lookAtEntity(id, mc, str(a, "target", "nearest")); return;
            case "turn":        turn(id, mc, (float) numOr(a, "yaw", 0), (float) numOr(a, "pitch", 0)); return;
            case "jump":        p.jumpFromGround(); release(id, true, "跳了一下"); return;
            case "sprint":      boolean on = !(a.has("on") && a.get("on").isJsonPrimitive() && !a.get("on").getAsBoolean());
                                mc.options.keySprint.setDown(on); release(id, true, on ? "已开启疾跑" : "已关闭疾跑"); return;
            case "stop":        stopAll(mc); release(id, true, "已停止当前动作"); return;
            case "idle":        release(id, true, "选择静止片刻"); return;
            case "get_inventory": release(id, true, inventoryText(mc)); return;
            case "get_position": release(id, true, String.format("位置 %.1f,%.1f,%.1f", p.getX(), p.getY(), p.getZ())); return;
            case "scan_area":   release(id, true, scanText(mc, (int) numOr(a, "radius", 12))); return;
            case "drop":        begin(id, new DropTask(mc, str(a, "item", ""), (int) numOr(a, "count", 1))); return;
            case "equip":       equip(id, mc, str(a, "item", "")); return;
            case "swap_slots":  swapSlots(id, mc, (int) numOr(a, "a", 0), (int) numOr(a, "b", 1)); return;
            case "get_health":  release(id, true, healthText(mc)); return;
            case "sort_inventory": sortInventory(id, mc); return;

            // ---- 多 tick 动作 ----
            case "move_to":     beginMove(id, mc, v3(numOr(a,"x",0), numOr(a,"y",0), numOr(a,"z",0)), 1.5); return;
            case "swim_to":     beginMove(id, mc, v3(numOr(a,"x",0), numOr(a,"y",0), numOr(a,"z",0)), 1.5); return;
            case "move_near":   beginMoveNear(id, mc, a); return;
            case "move_dir":    beginDir(id, mc, str(a, "direction", "forward"), numOr(a, "seconds", 0.6)); return;
            case "follow":      beginFollow(id, mc, a); return;
            case "stop_follow": begin(id, new StopFollowTask(mc)); return;
            case "dig":         beginDig(id, mc, new BlockPos(floor(numOr(a,"x",0)), floor(numOr(a,"y",0)), floor(numOr(a,"z",0)))); return;
            case "place":       beginPlace(id, mc, a); return;
            case "use_on":      beginUseOn(id, mc, new BlockPos(floor(numOr(a,"x",0)), floor(numOr(a,"y",0)), floor(numOr(a,"z",0)))); return;
            case "press_button": beginUseOn(id, mc, new BlockPos(floor(numOr(a,"x",0)), floor(numOr(a,"y",0)), floor(numOr(a,"z",0)))); return;
            case "open_door":   beginUseOnSuffix(id, mc, "_door"); return;
            case "close_door":  beginUseOnSuffix(id, mc, "_door"); return;
            case "sleep_in_bed": beginUseOnSuffix(id, mc, "_bed"); return;
            case "use_item":    beginUseItem(id, mc); return;
            case "attack":      beginAttack(id, mc, a); return;
            case "pickup":      beginPickup(id, mc); return;
            case "wait":        begin(id, new WaitTask((int) Math.max(1, numOr(a, "seconds", 1) * 20))); return;
            case "find_block":  beginFindBlock(id, mc, str(a, "name", ""), (int) numOr(a, "radius", 16)); return;
            case "find_entity": beginFindEntity(id, mc, str(a, "name", "nearest"), (int) numOr(a, "radius", 32)); return;
            case "respawn":     respawn(id, mc); return;
            case "eat":         begin(id, new EatTask(mc)); return;
            case "sneak":       sneak(id, mc, a); return;
            case "select_slot": selectSlot(id, mc, (int) numOr(a, "slot", 0)); return;
            case "drop_all":    begin(id, new DropAllTask(mc, str(a, "item", ""))); return;
            case "mount":       mount(id, mc, str(a, "target", "nearest")); return;
            case "dismount":    dismount(id, mc); return;

            case "craft":               begin(id, new CraftTask(mc, str(a, "item", ""), (int) numOr(a, "count", 1))); return;
            case "smelt":               begin(id, new SmeltTask(mc, str(a, "item", ""), (int) numOr(a, "count", 1))); return;
            case "open_container":      openContainer(id, mc, a); return;
            case "close_container":     closeContainer(id, mc); return;
            case "take_from_container": takeFromContainer(id, mc, str(a, "item", ""), (int) numOr(a, "count", 1)); return;
            case "put_to_container":    putToContainer(id, mc, str(a, "item", ""), (int) numOr(a, "count", 1)); return;

            default:
                release(id, false, "未知动作: " + name);
        }
    }

    // ---------------- tick 驱动 ----------------
    public void tick() {
        if (task == null) return;
        int r;
        try { r = task.tick(); } catch (Throwable t) { r = 2; }
        if (r != 0) {
            send(taskId, r == 1, task.detail());
            task = null;
            taskId = -1;
            releaseControls();
        }
    }

    private void begin(int id, Task t) {
        if (task != null) { send(taskId, false, "被新动作打断"); releaseControls(); }
        task = t; taskId = id;
    }

    private void release(int id, boolean ok, String detail) { send(id, ok, detail); }
    private void send(int id, boolean ok, String detail) { server.sendResult(id, ok, detail); }

    private void releaseControls() {
        Minecraft mc = Minecraft.getInstance();
        try {
            mc.options.keyUp.setDown(false);
            mc.options.keyDown.setDown(false);
            mc.options.keyLeft.setDown(false);
            mc.options.keyRight.setDown(false);
            mc.options.keyJump.setDown(false);
            mc.options.keySprint.setDown(false);
            mc.options.keyShift.setDown(false);
            if (mc.gameMode != null) mc.gameMode.stopDestroyBlock();
        } catch (Throwable ignored) {}
    }

    // ============================================================
    //  立即动作实现
    // ============================================================
    private void chat(int id, Minecraft mc, String msg) {
        if (msg == null || msg.isEmpty()) { release(id, false, "消息为空"); return; }
        mc.player.connection.sendChat(msg);
        release(id, true, "已发送：" + msg);
    }

    private void whisper(int id, Minecraft mc, String player, String msg) {
        if (player.isEmpty() || msg.isEmpty()) { release(id, false, "需要 player 与 message"); return; }
        mc.player.connection.sendCommand("msg " + player + " " + msg);
        release(id, true, "已私聊 " + player);
    }

    private void lookAt(int id, Minecraft mc, double x, double y, double z) {
        if (Double.isNaN(x) || Double.isNaN(y) || Double.isNaN(z)) { release(id, false, "缺少坐标"); return; }
        face(mc.player, new Vec3(x, y, z));
        release(id, true, String.format("已看向 %.1f,%.1f,%.1f", x, y, z));
    }

    private void lookAtEntity(int id, Minecraft mc, String spec) {
        Entity e = findEntity(mc, spec);
        if (e == null) { release(id, false, "找不到实体 " + spec); return; }
        face(mc.player, e.position().add(0, e.getBbHeight() * 0.9, 0));
        release(id, true, "已看向 " + name(e));
    }

    private void turn(int id, Minecraft mc, float yaw, float pitch) {
        mc.player.setYRot(yaw);
        mc.player.setXRot(pitch);
        release(id, true, "视角已转到 yaw=" + yaw + " pitch=" + pitch);
    }

    private void equip(int id, Minecraft mc, String item) {
        if (item.isEmpty()) { release(id, false, "需要 item"); return; }
        var inv = mc.player.getInventory();
        for (int i = 0; i < 9; i++) {
            ItemStack s = inv.getItem(i);
            if (!s.isEmpty() && reg(s).equals(item)) {
                inv.selected = i;
                release(id, true, "已切换到 " + item);
                return;
            }
        }
        release(id, false, "快捷栏里没有 " + item);
    }

    // ============================================================
    //  目标解析
    // ============================================================
    private void beginMove(int id, Minecraft mc, Vec3 target, double range) {
        beginPath(id, mc, target, "走向目标", range);
    }

    /** 优先体素 A* 寻路；找不到路径时回退到简易转向控制 */
    private void beginPath(int id, Minecraft mc, Vec3 target, String detail, double range) {
        BlockPos goal = new BlockPos((int) Math.floor(target.x), (int) Math.floor(target.y), (int) Math.floor(target.z));
        List<BlockPos> path = AStar.find(mc, mc.player.blockPosition(), goal);
        if (path != null && path.size() > 1) { begin(id, new PathTask(mc, path, detail)); return; }
        begin(id, new MoveTask(mc, target, range, detail));
    }

    private void beginMoveNear(int id, Minecraft mc, JsonObject a) {
        String kind = a.has("target") ? a.get("target").getAsString() : "block";
        String name = a.has("name") ? a.get("name").getAsString() : "";
        double dist = numOr(a, "distance", 2);
        if ("block".equals(kind)) {
            BlockPos bp = findBlockByName(mc, name, 24);
            if (bp == null) { release(id, false, "附近找不到方块 " + name); return; }
            beginPath(id, mc, Vec3.atCenterOf(bp), "靠近 " + name, dist);
        } else {
            Entity e = findEntity(mc, name.isEmpty() ? (a.has("target") ? a.get("target").getAsString() : "nearest") : name);
            if (e == null) { release(id, false, "附近找不到目标 " + name); return; }
            beginPath(id, mc, e.position(), "靠近 " + name(e), dist);
        }
    }

    private void beginDir(int id, Minecraft mc, String dir, double seconds) {
        begin(id, new DirTask(mc, dir, (int) Math.max(3, seconds * 20)));
    }

    private void beginFollow(int id, Minecraft mc, JsonObject a) {
        String name = a.has("target") ? a.get("target").getAsString() : "nearest";
        double dist = numOr(a, "distance", 3);
        Entity e = findEntity(mc, name);
        if (e == null) { release(id, false, "找不到跟随目标 " + name); return; }
        begin(id, new FollowTask(mc, e, dist));
    }

    private void beginDig(int id, Minecraft mc, BlockPos pos) {
        BlockState st = mc.level.getBlockState(pos);
        if (st.isAir()) { release(id, false, pos.toShortString() + " 没有方块"); return; }
        String bn = BuiltInRegistries.BLOCK.getKey(st.getBlock()).getPath();
        begin(id, new DigTask(mc, pos, bn));
    }

    private void beginUseOn(int id, Minecraft mc, BlockPos pos) {
        BlockState st = mc.level.getBlockState(pos);
        if (st.isAir()) { release(id, false, "目标位置没有方块"); return; }
        begin(id, new UseOnTask(mc, pos, "已对 " + pos.toShortString() + " 使用"));
    }

    private void beginUseOnSuffix(int id, Minecraft mc, String suffix) {
        BlockPos bp = findBlockBySuffix(mc, suffix, 16);
        if (bp == null) { release(id, false, "附近找不到 *" + suffix + " 方块"); return; }
        begin(id, new UseOnTask(mc, bp, "已对 " + BuiltInRegistries.BLOCK.getKey(mc.level.getBlockState(bp).getBlock()).getPath() + " 使用"));
    }

    private void beginPlace(int id, Minecraft mc, JsonObject a) {
        LocalPlayer p = mc.player;
        BlockPos pos = new BlockPos(floor(numOr(a, "x", 0)), floor(numOr(a, "y", 0)), floor(numOr(a, "z", 0)));
        String block = a.has("block") ? a.get("block").getAsString() : "";
        if (!block.isEmpty()) {
            var inv = p.getInventory();
            boolean found = false;
            for (int i = 0; i < 9; i++) { ItemStack s = inv.getItem(i); if (!s.isEmpty() && reg(s).equals(block)) { inv.selected = i; found = true; break; } }
            if (!found) { release(id, false, "快捷栏里没有 " + block); return; }
        }
        BlockState cur = mc.level.getBlockState(pos);
        if (!cur.isAir() && !cur.canBeReplaced()) { release(id, false, "目标位置已被占用"); return; }
        Direction[] dirs = {Direction.DOWN, Direction.UP, Direction.NORTH, Direction.SOUTH, Direction.WEST, Direction.EAST};
        BlockPos ref = null; Direction placeFace = null;
        for (Direction d : dirs) {
            BlockPos n = pos.relative(d);
            BlockState ns = mc.level.getBlockState(n);
            if (!ns.isAir() && ns.isSolid()) { ref = n; placeFace = d.getOpposite(); break; }
        }
        if (ref == null) { release(id, false, "附近没有可依附的实心方块"); return; }
        Vec3 hit = Vec3.atCenterOf(ref).add(placeFace.getStepX() * 0.5, placeFace.getStepY() * 0.5, placeFace.getStepZ() * 0.5);
        face(p, Vec3.atCenterOf(pos));
        mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, new BlockHitResult(hit, placeFace, ref, false));
        release(id, true, "已尝试放置 " + (block.isEmpty() ? "手持方块" : block));
    }

    private void stopAll(Minecraft mc) {
        if (task != null) { send(taskId, false, "被 stop 打断"); task = null; taskId = -1; }
        releaseControls();
    }

    private void beginUseItem(int id, Minecraft mc) {
        mc.gameMode.useItem(mc.player, InteractionHand.MAIN_HAND);
        release(id, true, "已使用手持物品");
    }

    private void beginAttack(int id, Minecraft mc, JsonObject a) {
        String target = a.has("target") ? a.get("target").getAsString() : "nearest";
        int times = (int) Math.max(1, Math.min(30, numOr(a, "times", 1)));
        begin(id, new AttackTask(mc, target, times));
    }

    private void beginPickup(int id, Minecraft mc) {
        Entity item = null;
        double best = 1e9;
        for (Entity e : mc.level.entitiesForRendering()) {
            if (!isItem(e)) continue;
            double d = e.distanceTo(mc.player);
            if (d < best) { best = d; item = e; }
        }
        if (item == null) { release(id, false, "附近没有掉落物"); return; }
        begin(id, new MoveTask(mc, item.position(), 1.2, "走向掉落物"));
    }

    private void beginFindBlock(int id, Minecraft mc, String name, int radius) {
        BlockPos bp = findBlockByName(mc, name, radius);
        if (bp == null) release(id, false, "附近找不到方块 " + name);
        else release(id, true, String.format("找到 %s @ %d,%d,%d（%.1f格）", name, bp.getX(), bp.getY(), bp.getZ(),
                Math.sqrt(mc.player.distanceToSqr(bp.getX() + .5, bp.getY() + .5, bp.getZ() + .5))));
    }

    private void beginFindEntity(int id, Minecraft mc, String name, int radius) {
        Entity e = findEntity(mc, name);
        if (e == null || e.distanceTo(mc.player) > radius) release(id, false, "附近找不到实体 " + name);
        else release(id, true, String.format("找到 %s @ %.1f,%.1f,%.1f（%.1f格）", name(e), e.getX(), e.getY(), e.getZ(), e.distanceTo(mc.player)));
    }

    // ============================================================
    //  高阶 / 状态类动作
    // ============================================================
    private void respawn(int id, Minecraft mc) {
        if (mc.player == null) { release(id, false, "客户端尚未进入世界"); return; }
        mc.player.respawn();
        release(id, true, "已请求重生");
    }

    private void sneak(int id, Minecraft mc, JsonObject a) {
        boolean on = true;
        if (a.has("on") && a.get("on").isJsonPrimitive()) on = a.get("on").getAsBoolean();
        mc.options.keyShift.setDown(on);
        release(id, true, on ? "已进入潜行" : "已取消潜行");
    }

    private void selectSlot(int id, Minecraft mc, int slot) {
        if (mc.player == null) { release(id, false, "客户端尚未进入世界"); return; }
        int s = Math.max(0, Math.min(8, slot));
        mc.player.getInventory().selected = s;
        release(id, true, "已切换到快捷栏槽 " + s);
    }

    private void mount(int id, Minecraft mc, String target) {
        if (mc.player == null) { release(id, false, "客户端尚未进入世界"); return; }
        Entity e = findEntity(mc, target);
        if (e == null) { release(id, false, "附近没有可骑乘的目标"); return; }
        face(mc.player, e.position());
        mc.gameMode.interact(mc.player, e, InteractionHand.MAIN_HAND);
        release(id, true, "已尝试骑乘 " + name(e));
    }

    private void dismount(int id, Minecraft mc) {
        if (mc.player == null) { release(id, false, "客户端尚未进入世界"); return; }
        if (mc.player.getVehicle() == null) { release(id, false, "你并不在坐骑上"); return; }
        begin(id, new SneakHoldTask(mc));
    }

    // ============================================================
    //  容器 / 合成 / 熔炼（对齐 mineflayer 的操作能力）
    // ============================================================
    private void openContainer(int id, Minecraft mc, com.google.gson.JsonObject a) {
        net.minecraft.client.player.LocalPlayer p = mc.player;
        if (p == null || mc.level == null) { release(id, false, "客户端尚未进入世界"); return; }
        net.minecraft.core.BlockPos pos = null;
        if (a.has("x") && a.has("y") && a.has("z")) {
            pos = new net.minecraft.core.BlockPos((int) numOr(a, "x", 0), (int) numOr(a, "y", 0), (int) numOr(a, "z", 0));
        } else {
            String nm = str(a, "name", "");
            if (!nm.isEmpty()) pos = findBlockByName(mc, nm, 4);
            if (pos == null) { String sfx = str(a, "suffix", ""); if (!sfx.isEmpty()) pos = findBlockBySuffix(mc, sfx, 4); }
        }
        if (pos == null) { release(id, false, "找不到要打开的容器（请给 x/y/z 或方块名）"); return; }
        net.minecraft.world.phys.Vec3 center = net.minecraft.world.phys.Vec3.atCenterOf(pos);
        net.minecraft.world.phys.Vec3 diff = p.getEyePosition().subtract(center);
        net.minecraft.core.Direction faceDir = net.minecraft.core.Direction.getNearest(diff.x, diff.y, diff.z);
        face(p, center);
        mc.gameMode.useItemOn(p, net.minecraft.world.InteractionHand.MAIN_HAND,
                new net.minecraft.world.phys.BlockHitResult(center, faceDir, pos, false));
        String bn = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(mc.level.getBlockState(pos).getBlock()).toString();
        release(id, true, "已尝试打开 " + bn);
    }

    private void closeContainer(int id, Minecraft mc) {
        if (mc.player == null) { release(id, false, "客户端尚未进入世界"); return; }
        mc.player.closeContainer();
        mc.setScreen(null);
        release(id, true, "已关闭容器");
    }

    private net.minecraft.world.inventory.AbstractContainerMenu openContainerMenu(int id, Minecraft mc) {
        if (mc.player == null) { release(id, false, "客户端尚未进入世界"); return null; }
        net.minecraft.world.inventory.AbstractContainerMenu menu = mc.player.containerMenu;
        if (menu == null || menu.slots.size() <= 36) { release(id, false, "当前没有打开可交互的容器（先 open_container）"); return null; }
        return menu;
    }

    private void takeFromContainer(int id, Minecraft mc, String item, int count) {
        net.minecraft.world.inventory.AbstractContainerMenu menu = openContainerMenu(id, mc);
        if (menu == null) return;
        int total = menu.slots.size();
        int cslots = total - 36;
        int moved = 0;
        for (int i = 0; i < cslots && moved < count; i++) {
            net.minecraft.world.item.ItemStack st = menu.getSlot(i).getItem();
            if (matchItem(st, item)) {
                mc.gameMode.handleInventoryMouseClick(menu.containerId, i, 0, net.minecraft.world.inventory.ClickType.QUICK_MOVE, mc.player);
                moved += st.getCount();
            }
        }
        release(id, moved > 0, moved > 0 ? ("已从容器取出约 " + moved + " " + item) : ("容器里没有 " + item));
    }

    private void putToContainer(int id, Minecraft mc, String item, int count) {
        net.minecraft.world.inventory.AbstractContainerMenu menu = openContainerMenu(id, mc);
        if (menu == null) return;
        int total = menu.slots.size();
        int cslots = total - 36;
        int moved = 0;
        for (int i = cslots; i < total && moved < count; i++) {
            net.minecraft.world.item.ItemStack st = menu.getSlot(i).getItem();
            if (matchItem(st, item)) {
                mc.gameMode.handleInventoryMouseClick(menu.containerId, i, 0, net.minecraft.world.inventory.ClickType.QUICK_MOVE, mc.player);
                moved += st.getCount();
            }
        }
        release(id, moved > 0, moved > 0 ? ("已放入约 " + moved + " " + item) : ("背包里没有 " + item));
    }

    private static boolean matchItem(net.minecraft.world.item.ItemStack st, String want) {
        if (st == null || st.isEmpty()) return false;
        if (want == null || want.isEmpty()) return true;
        String reg = net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(st.getItem()).toString();
        return reg.equals(want) || reg.endsWith(":" + want);
    }

    private static int findItemSlot(net.minecraft.world.inventory.AbstractContainerMenu menu, int from, int to, String want) {
        String w = (want == null) ? "" : want;
        for (int i = from; i < to; i++) {
            net.minecraft.world.item.ItemStack st = menu.getSlot(i).getItem();
            if (st.isEmpty()) continue;
            String reg = net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(st.getItem()).toString();
            if (w.isEmpty() || reg.equals(w) || reg.endsWith(":" + w)) return i;
        }
        return -1;
    }

    // 用「配方书」自动摆料合成；需要背包或工作台界面处于打开状态
    private static class CraftTask implements Task {
        final Minecraft mc; final String item; final int want;
        int done = 0; int tries = 0; int cool = 0;
        CraftTask(Minecraft mc, String item, int want) { this.mc = mc; this.item = item; this.want = Math.max(1, want); }
        public int tick() {
            if (mc.player == null || mc.level == null) return 2;
            if (++cool < 5) return 0;
            cool = 0;
            net.minecraft.world.inventory.AbstractContainerMenu menu = mc.player.containerMenu;
            if (!(menu instanceof net.minecraft.world.inventory.RecipeBookMenu)) return 2;
            net.minecraft.world.item.crafting.CraftingRecipe recipe = null;
            for (net.minecraft.world.item.crafting.CraftingRecipe r : mc.level.getRecipeManager()
                    .getAllRecipesFor(net.minecraft.world.item.crafting.RecipeType.CRAFTING)) {
                net.minecraft.world.item.ItemStack out = r.getResultItem(mc.level.registryAccess());
                if (matchItem(out, item)) { recipe = r; break; }
            }
            if (recipe == null) return 2;
            try { mc.gameMode.handlePlaceRecipe(menu.containerId, recipe, true); } catch (Throwable t) { return 2; }
            net.minecraft.world.item.ItemStack res = menu.getSlot(0).getItem();
            if (!res.isEmpty() && matchItem(res, item)) {
                int n = res.getCount();
                mc.gameMode.handleInventoryMouseClick(menu.containerId, 0, 0, net.minecraft.world.inventory.ClickType.QUICK_MOVE, mc.player);
                done += n;
            }
            if (done >= want) return 1;
            if (++tries > 60) return 2;
            return 0;
        }
        public String detail() { return done > 0 ? ("已合成 " + done + " " + item) : ("无法合成 " + item + "（材料不足或需要工作台）"); }
    }

    // 需要在已打开的熔炉界面里：0=输入 1=燃料 2=输出
    private static class SmeltTask implements Task {
        final Minecraft mc; final String item; final int want;
        int done = 0; int tries = 0; int cool = 0;
        SmeltTask(Minecraft mc, String item, int want) { this.mc = mc; this.item = item; this.want = Math.max(1, want); }
        public int tick() {
            if (mc.player == null || mc.level == null) return 2;
            net.minecraft.world.inventory.AbstractContainerMenu menu = mc.player.containerMenu;
            if (!(menu instanceof net.minecraft.world.inventory.FurnaceMenu)) return 2;
            if (++cool < 10) return 0;
            cool = 0;
            net.minecraft.world.item.ItemStack out = menu.getSlot(2).getItem();
            if (!out.isEmpty() && matchItem(out, item)) {
                int n = out.getCount();
                mc.gameMode.handleInventoryMouseClick(menu.containerId, 2, 0, net.minecraft.world.inventory.ClickType.QUICK_MOVE, mc.player);
                done += n;
                if (done >= want) return 1;
            }
            if (menu.getSlot(0).getItem().isEmpty()) {
                int s = findItemSlot(menu, 36, menu.slots.size(), item);
                if (s >= 0) mc.gameMode.handleInventoryMouseClick(menu.containerId, s, 0, net.minecraft.world.inventory.ClickType.QUICK_MOVE, mc.player);
            }
            if (menu.getSlot(1).getItem().isEmpty()) {
                int s = findItemSlot(menu, 36, menu.slots.size(), "coal");
                if (s < 0) s = findItemSlot(menu, 36, menu.slots.size(), "charcoal");
                if (s < 0) s = findItemSlot(menu, 36, menu.slots.size(), "oak_planks");
                if (s < 0) s = findItemSlot(menu, 36, menu.slots.size(), "oak_log");
                if (s >= 0) mc.gameMode.handleInventoryMouseClick(menu.containerId, s, 0, net.minecraft.world.inventory.ClickType.QUICK_MOVE, mc.player);
            }
            if (++tries > 300) return 2;
            return 0;
        }
        public String detail() { return done > 0 ? ("已熔炼 " + done + " " + item) : ("熔炼未完成 " + item + "（需打开熔炉界面且材料/燃料充足）"); }
    }

    // ---------------- 背包槽位 / 状态文本 ----------------
    /** 三次 PICKUP 点击：交换窗口槽 a 与 b。 */
    private static void clickSwap(net.minecraft.world.inventory.AbstractContainerMenu menu, int a, int b, Minecraft mc) {
        mc.gameMode.handleInventoryMouseClick(menu.containerId, a, 0, net.minecraft.world.inventory.ClickType.PICKUP, mc.player);
        mc.gameMode.handleInventoryMouseClick(menu.containerId, b, 0, net.minecraft.world.inventory.ClickType.PICKUP, mc.player);
        mc.gameMode.handleInventoryMouseClick(menu.containerId, a, 0, net.minecraft.world.inventory.ClickType.PICKUP, mc.player);
    }

    private void swapSlots(int id, Minecraft mc, int a, int b) {
        if (mc.player == null) { release(id, false, "客户端尚未进入世界"); return; }
        try {
            var menu = mc.player.containerMenu;
            int size = menu.slots.size();
            if (a < 0 || b < 0 || a >= size || b >= size) { release(id, false, "槽位超出范围（当前共 " + size + " 个槽）"); return; }
            if (a == b) { release(id, true, "两个槽位相同，无需交换"); return; }
            clickSwap(menu, a, b, mc);
            release(id, true, "已交换槽位 " + a + " 与 " + b);
        } catch (Throwable t) { release(id, false, "交换失败：" + t.getMessage()); }
    }

    private String healthText(Minecraft mc) {
        var p = mc.player;
        if (p == null) return "客户端尚未进入世界";
        return String.format("生命 %.0f/%.0f；饥饿 %d；氧气 %d；经验等级 %d",
                p.getHealth(), p.getMaxHealth(), p.getFoodData().getFoodLevel(), p.getAirSupply(), p.experienceLevel);
    }

    /** 主背包（菜单槽 9..35）按物品注册名升序插入排序（尽力而为）。 */
    private void sortInventory(int id, Minecraft mc) {
        if (mc.player == null) { release(id, false, "客户端尚未进入世界"); return; }
        try {
            var menu = mc.player.containerMenu;
            int size = menu.slots.size();
            if (size < 46) { release(id, false, "需要玩家背包界面（槽位数不足）"); return; }
            java.util.List<Integer> slots = new java.util.ArrayList<>();
            java.util.List<String> names = new java.util.ArrayList<>();
            for (int s = 9; s <= 35; s++) {
                var st = menu.slots.get(s).getItem();
                if (st != null && !st.isEmpty()) { slots.add(s); names.add(BuiltInRegistries.ITEM.getKey(st.getItem()).toString()); }
            }
            for (int i = 1; i < names.size(); i++) {
                for (int j = i; j > 0 && names.get(j).compareTo(names.get(j - 1)) < 0; j--) {
                    clickSwap(menu, slots.get(j), slots.get(j - 1), mc);
                    java.util.Collections.swap(slots, j, j - 1);
                    java.util.Collections.swap(names, j, j - 1);
                }
            }
            release(id, true, "背包已按名称整理（共 " + names.size() + " 格物品，尽力而为）");
        } catch (Throwable t) { release(id, false, "整理失败：" + t.getMessage()); }
    }

    // ============================================================
    //  世界扫描 / 文本
    // ============================================================
    private String scanText(Minecraft mc, int radius) {
        LocalPlayer p = mc.player;
        BlockPos c = p.blockPosition();
        Map<String, Integer> counts = new LinkedHashMap<>();
        int r = Math.min(radius, 16);
        for (int dx = -r; dx <= r; dx += 2)
            for (int dz = -r; dz <= r; dz += 2)
                for (int dy = -2; dy <= 3; dy++) {
                    BlockState st = mc.level.getBlockState(c.offset(dx, dy, dz));
                    if (st.isAir()) continue;
                    String n = BuiltInRegistries.BLOCK.getKey(st.getBlock()).getPath();
                    counts.merge(n, 1, Integer::sum);
                }
        StringBuilder sb = new StringBuilder("附近方块：");
        counts.entrySet().stream().sorted((x, y) -> y.getValue() - x.getValue()).limit(10)
                .forEach(e -> sb.append(e.getKey()).append("×").append(e.getValue()).append("，"));
        return sb.toString();
    }

    private String inventoryText(Minecraft mc) {
        var inv = mc.player.getInventory();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack s = inv.getItem(i);
            if (!s.isEmpty()) sb.append(reg(s)).append("×").append(s.getCount()).append("(槽").append(i).append(") ");
        }
        return sb.length() == 0 ? "背包空" : sb.toString();
    }

    private BlockPos findBlockByName(Minecraft mc, String name, int radius) {
        if (name == null || name.isEmpty()) return null;
        return findBlockByPredicate(mc, radius, path -> path.equals(name));
    }

    private BlockPos findBlockBySuffix(Minecraft mc, String suffix, int radius) {
        return findBlockByPredicate(mc, radius, path -> path.endsWith(suffix));
    }

    private BlockPos findBlockByPredicate(Minecraft mc, int radius, java.util.function.Predicate<String> pred) {
        LocalPlayer p = mc.player;
        BlockPos c = p.blockPosition();
        BlockPos best = null; double bestD = 1e9;
        int r = Math.min(radius, 24);
        for (int dx = -r; dx <= r; dx++)
            for (int dz = -r; dz <= r; dz++)
                for (int dy = -4; dy <= 6; dy++) {
                    BlockPos pos = c.offset(dx, dy, dz);
                    BlockState st = mc.level.getBlockState(pos);
                    if (st.isAir()) continue;
                    if (pred.test(BuiltInRegistries.BLOCK.getKey(st.getBlock()).getPath())) {
                        double d = p.distanceToSqr(pos.getX() + .5, pos.getY() + .5, pos.getZ() + .5);
                        if (d < bestD) { bestD = d; best = pos.immutable(); }
                    }
                }
        return best;
    }

    private Entity findEntity(Minecraft mc, String spec) {
        if (mc.level == null) return null;
        if (spec == null || spec.equals("nearest")) {
            Entity best = null; double bd = 1e9;
            for (Entity e : mc.level.entitiesForRendering()) {
                if (e == mc.player) continue;
                double d = e.distanceTo(mc.player);
                if (d < bd) { bd = d; best = e; }
            }
            return best;
        }
        String s = spec.toLowerCase();
        Entity best = null; double bd = 1e9;
        for (Player pl : mc.level.players()) {
            if (pl != mc.player && pl.getGameProfile().getName().toLowerCase().contains(s)) return pl;
        }
        for (Entity e : mc.level.entitiesForRendering()) {
            if (e == mc.player) continue;
            String nm = name(e).toLowerCase();
            if (nm.contains(s)) {
                double d = e.distanceTo(mc.player);
                if (d < bd) { bd = d; best = e; }
            }
        }
        return best;
    }

    private static String name(Entity e) {
        if (e instanceof Player pl) return pl.getGameProfile().getName();
        try { return BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).getPath(); } catch (Throwable t) { return "entity"; }
    }

    private static boolean isItem(Entity e) {
        try { return BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).getPath().equals("item"); } catch (Throwable t) { return false; }
    }

    private static String reg(ItemStack s) {
        return BuiltInRegistries.ITEM.getKey(s.getItem()).getPath();
    }

    private static void face(LocalPlayer p, Vec3 target) {
        Vec3 d = target.subtract(p.getEyePosition());
        double horiz = Math.sqrt(d.x * d.x + d.z * d.z);
        float yaw = (float) Math.toDegrees(Math.atan2(-d.x, d.z));
        float pitch = (float) Math.toDegrees(-Math.atan2(d.y, horiz));
        p.setYRot(yaw);
        p.setXRot(pitch);
    }

    private static Vec3 v3(double x, double y, double z) { return new Vec3(x, y, z); }
    private static int floor(double d) { return (int) Math.floor(d); }
    private static String str(JsonObject a, String k, String def) { return a.has(k) && a.get(k).isJsonPrimitive() ? a.get(k).getAsString() : def; }
    private static double num(JsonObject a, String k) { return a.has(k) && a.get(k).isJsonPrimitive() ? a.get(k).getAsDouble() : Double.NaN; }
    private static double numOr(JsonObject a, String k, double def) { double v = num(a, k); return Double.isNaN(v) ? def : v; }

    // ============================================================
    //  Task 状态机（0=进行中, 1=成功, 2=失败）
    // ============================================================
    private interface Task { int tick(); String detail(); }

    /** 简易转向移动控制器（非 A*）：把视角转向目标并按住前进键。 */
    // ============================================================
    //  体素 A* 寻路（客户端本地）
    // ============================================================
    private static final class AStar {
        static List<BlockPos> find(Minecraft mc, BlockPos start, BlockPos goal) {
            if (mc.level == null || mc.player == null || start.equals(goal)) return null;
            Map<BlockPos, BlockPos> came = new HashMap<>();
            Map<BlockPos, Double> g = new HashMap<>();
            PriorityQueue<BlockPos> open = new PriorityQueue<>(Comparator.comparingDouble(n -> g.getOrDefault(n, 1e9) + h(n, goal)));
            Set<BlockPos> closed = new HashSet<>();
            g.put(start, 0.0); open.add(start);
            int expanded = 0;
            int[][] dirs = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
            while (!open.isEmpty() && expanded < 4000) {
                BlockPos cur = open.poll();
                if (closed.contains(cur)) continue;
                closed.add(cur); expanded++;
                if (near(cur, goal)) {
                    List<BlockPos> path = new ArrayList<>();
                    BlockPos n = cur;
                    while (n != null) { path.add(0, n); n = came.get(n); }
                    return path;
                }
                for (int[] d : dirs) {
                    int nx = cur.getX() + d[0], nz = cur.getZ() + d[1];
                    for (int dy : new int[]{0, 1, -1, -2, -3}) {
                        BlockPos cand = new BlockPos(nx, cur.getY() + dy, nz);
                        if (closed.contains(cand) || !passable(mc, cand)) continue;
                        double ng = g.getOrDefault(cur, 1e9) + 1 + Math.abs(dy) * 0.25;
                        if (ng < g.getOrDefault(cand, 1e9)) { g.put(cand, ng); came.put(cand, cur); open.add(cand); }
                        break;
                    }
                }
            }
            return null;
        }
        private static boolean passable(Minecraft mc, BlockPos p) {
            return isFree(mc, p) && isFree(mc, p.above()) && isSolid(mc, p.below());
        }
        private static boolean isFree(Minecraft mc, BlockPos p) {
            BlockState s = mc.level.getBlockState(p);
            return s.isAir() || !s.blocksMotion();
        }
        private static boolean isSolid(Minecraft mc, BlockPos p) {
            BlockState s = mc.level.getBlockState(p);
            return !s.isAir() && s.blocksMotion();
        }
        private static boolean near(BlockPos a, BlockPos b) {
            return Math.abs(a.getX() - b.getX()) <= 1 && Math.abs(a.getY() - b.getY()) <= 1 && Math.abs(a.getZ() - b.getZ()) <= 1;
        }
        private static double h(BlockPos a, BlockPos b) {
            return Math.abs(a.getX() - b.getX()) + Math.abs(a.getY() - b.getY()) + Math.abs(a.getZ() - b.getZ());
        }
    }

    /** 沿 A* 路点行走 */
    private static class PathTask implements Task {
        final Minecraft mc; final List<BlockPos> path; final String label;
        int idx = 1; int stuck = 0; double lastD = 1e9;
        final long deadline = System.currentTimeMillis() + 40000;
        PathTask(Minecraft mc, List<BlockPos> path, String label) { this.mc = mc; this.path = path; this.label = label; }
        public int tick() {
            LocalPlayer p = mc.player;
            if (p == null) { return 2; }
            if (idx >= path.size()) { mc.options.keyUp.setDown(false); mc.options.keyJump.setDown(false); return 1; }
            if (System.currentTimeMillis() > deadline) { mc.options.keyUp.setDown(false); mc.options.keyJump.setDown(false); return 2; }
            mc.options.keyShift.setDown(false);
            BlockPos wp = path.get(idx);
            Vec3 center = Vec3.atCenterOf(wp);
            double d = p.position().distanceTo(center);
            if (d < 1.3) { idx++; stuck = 0; lastD = 1e9; return 0; }
            if (d > lastD - 0.02) stuck++; else stuck = 0;
            lastD = d;
            face(p, center);
            mc.options.keyUp.setDown(true);
            mc.options.keyJump.setDown(wp.getY() > p.blockPosition().getY() && d < 1.9);
            if (stuck > 45) { mc.options.keyUp.setDown(false); mc.options.keyJump.setDown(false); return 2; }
            return 0;
        }
        public String detail() { return label; }
    }

    private static class MoveTask implements Task {
        final Minecraft mc; final Vec3 target; final double range; final String label;
        final long deadline;
        MoveTask(Minecraft mc, Vec3 target, double range, String label) {
            this.mc = mc; this.target = target; this.range = range; this.label = label;
            this.deadline = System.currentTimeMillis() + 25000;
        }
        public int tick() {
            LocalPlayer p = mc.player;
            if (p == null) return 2;
            double dx = target.x - p.getX(), dz = target.z - p.getZ();
            double hd = Math.sqrt(dx * dx + dz * dz);
            if (hd <= range) { stop(); return 1; }
            if (System.currentTimeMillis() > deadline) { stop(); return 2; }
            face(p, target);
            mc.options.keyShift.setDown(false);   // 移动时必须取消潜行，否则玩家不会走出方块边缘、永远走不出去
            mc.options.keyUp.setDown(true);
            mc.options.keySprint.setDown(hd > 4);
            return 0;
        }
        private void stop() {
            mc.options.keyUp.setDown(false);
            mc.options.keySprint.setDown(false);
        }
        public String detail() { return label + "（简单转向，非寻路）"; }
    }

    private static class DirTask implements Task {
        final Minecraft mc; final String dir; int ticks;
        DirTask(Minecraft mc, String dir, int ticks) { this.mc = mc; this.dir = dir; this.ticks = ticks; }
        public int tick() {
            if (ticks-- <= 0) { clear(); return 1; }
            switch (dir) {
                case "forward": mc.options.keyShift.setDown(false); mc.options.keyUp.setDown(true); break;
                case "back": case "backward": mc.options.keyShift.setDown(false); mc.options.keyDown.setDown(true); break;
                case "left": mc.options.keyShift.setDown(false); mc.options.keyLeft.setDown(true); break;
                case "right": mc.options.keyShift.setDown(false); mc.options.keyRight.setDown(true); break;
                case "up": case "jump": mc.options.keyJump.setDown(true); break;
                case "down": case "sneak": mc.options.keyShift.setDown(true); break;
            }
            return 0;
        }
        private void clear() {
            mc.options.keyUp.setDown(false); mc.options.keyDown.setDown(false);
            mc.options.keyLeft.setDown(false); mc.options.keyRight.setDown(false);
            mc.options.keyJump.setDown(false); mc.options.keyShift.setDown(false);
        }
        public String detail() { return "已朝 " + dir + " 移动"; }
    }

    private static class FollowTask implements Task {
        final Minecraft mc; final Entity target; final double dist;
        final long deadline;
        FollowTask(Minecraft mc, Entity target, double dist) { this.mc = mc; this.target = target; this.dist = dist; this.deadline = System.currentTimeMillis() + 15000; }
        public int tick() {
            if (target == null || !target.isAlive()) return 2;
            double d = target.distanceTo(mc.player);
            if (d <= dist) { mc.options.keyUp.setDown(false); return 1; }
            if (System.currentTimeMillis() > deadline) { mc.options.keyUp.setDown(false); return 2; }
            face(mc.player, target.position());
            mc.options.keyUp.setDown(true);
            return 0;
        }
        public String detail() { return "已接近跟随目标"; }
    }

    private static class StopFollowTask implements Task {
        final Minecraft mc;
        StopFollowTask(Minecraft mc) { this.mc = mc; }
        public int tick() { mc.options.keyUp.setDown(false); return 1; }
        public String detail() { return "已停止跟随"; }
    }

    private static class DigTask implements Task {
        final Minecraft mc; final BlockPos pos; final String block; int ticks = 0; boolean started = false;
        DigTask(Minecraft mc, BlockPos pos, String block) { this.mc = mc; this.pos = pos; this.block = block; }
        public int tick() {
            if (mc.level.getBlockState(pos).isAir()) { mc.gameMode.stopDestroyBlock(); return 1; }
            LocalPlayer p = mc.player;
            Vec3 center = Vec3.atCenterOf(pos);
            // 太远：先靠近（转向 + 前进），最多约 8 秒
            if (p.getEyePosition().distanceTo(center) > 4.4) {
                if (ticks++ > 160) { mc.options.keyUp.setDown(false); mc.gameMode.stopDestroyBlock(); return 2; }
                face(p, center);
                mc.options.keyUp.setDown(true);
                return 0;
            }
            mc.options.keyUp.setDown(false);
            if (ticks++ > 300) { mc.gameMode.stopDestroyBlock(); return 2; }
            face(p, center); // 矄准方块（相当于左键对准）
            Direction face = Direction.getNearest(p.getX() - (pos.getX() + .5), p.getY() + 1 - (pos.getY() + .5), p.getZ() - (pos.getZ() + .5));
            if (!started) { started = true; mc.gameMode.startDestroyBlock(pos, face); }
            mc.gameMode.continueDestroyBlock(pos, face);
            return 0;
        }
        public String detail() { return "已挖掉 " + block; }
    }

    private static class UseOnTask implements Task {
        final Minecraft mc; final BlockPos pos; final String label; int ticks = 0;
        UseOnTask(Minecraft mc, BlockPos pos, String label) { this.mc = mc; this.pos = pos; this.label = label; }
        public int tick() {
            LocalPlayer p = mc.player;
            Vec3 center = Vec3.atCenterOf(pos);
            if (p.getEyePosition().distanceTo(center) > 4.4) {
                if (ticks++ > 160) { mc.options.keyUp.setDown(false); return 2; }
                face(p, center); mc.options.keyUp.setDown(true); return 0;
            }
            mc.options.keyUp.setDown(false);
            face(p, center); // 矄准方块（相当于右键对准）
            Vec3 diff = p.getEyePosition().subtract(center);
            Direction face = Direction.getNearest(diff.x, diff.y, diff.z);
            mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, new BlockHitResult(center, face, pos, false));
            return 1;
        }
        public String detail() { return label; }
    }

    private static class AttackTask implements Task {
        final Minecraft mc; final String target; int left;
        AttackTask(Minecraft mc, String target, int times) { this.mc = mc; this.target = target; this.left = times; }
        public int tick() {
            Entity found = null;
            if (target == null || target.equals("nearest")) {
                double bd = 1e9;
                for (Entity en : mc.level.entitiesForRendering()) { if (en == mc.player) continue; double d = en.distanceTo(mc.player); if (d < bd) { bd = d; found = en; } }
            } else {
                String s = target.toLowerCase();
                double bd = 1e9;
                for (Entity en : mc.level.entitiesForRendering()) { if (en == mc.player) continue; String nm = name(en).toLowerCase(); if (nm.contains(s)) { double d = en.distanceTo(mc.player); if (d < bd) { bd = d; found = en; } } }
            }
            if (found == null || !found.isAlive()) return 2;
            if (mc.player.distanceTo(found) > 3.2) { face(mc.player, found.position()); mc.options.keyUp.setDown(true); return 0; }
            mc.options.keyUp.setDown(false);
            face(mc.player, found.position()); // 矄准目标（左键）
            mc.gameMode.attack(mc.player, found);
            if (--left <= 0) return 1;
            return 0;
        }
        public String detail() { return "已攻击目标"; }
    }

    private static class DropTask implements Task {
        final Minecraft mc; final String item; int left;
        DropTask(Minecraft mc, String item, int count) { this.mc = mc; this.item = item; this.left = Math.max(1, count); }
        public int tick() {
            var inv = mc.player.getInventory();
            ItemStack sel = inv.getItem(inv.selected);
            if (!item.isEmpty() && (sel.isEmpty() || !reg(sel).equals(item))) {
                for (int i = 0; i < 9; i++) { ItemStack s = inv.getItem(i); if (!s.isEmpty() && reg(s).equals(item)) { inv.selected = i; break; } }
            }
            mc.player.drop(false);
            if (--left <= 0) return 1;
            return 0;
        }
        public String detail() { return "已丢弃物品"; }
    }

    private static class SneakHoldTask implements Task {
        final Minecraft mc; int ticks = 0;
        SneakHoldTask(Minecraft mc) { this.mc = mc; }
        public int tick() {
            mc.options.keyShift.setDown(true);
            if (++ticks > 8) { mc.options.keyShift.setDown(false); return 1; }
            return 0;
        }
        public String detail() { return "已尝试下坐骑（按住潜行）"; }
    }

    private static class EatTask implements Task {
        final Minecraft mc; int ticks = 0;
        EatTask(Minecraft mc) { this.mc = mc; }
        public int tick() {
            mc.options.keyUse.setDown(true);
            if (++ticks > 40) { mc.options.keyUse.setDown(false); return 1; }
            return 0;
        }
        public String detail() { return "已进食/使用手中物品"; }
    }

    private static class DropAllTask implements Task {
        final Minecraft mc; final String item; int guard = 999;
        DropAllTask(Minecraft mc, String item) { this.mc = mc; this.item = item; }
        public int tick() {
            var inv = mc.player.getInventory();
            int found = -1;
            for (int i = 0; i < 9; i++) {
                ItemStack s = inv.getItem(i);
                if (s.isEmpty()) continue;
                if (item.isEmpty() || reg(s).equals(item)) { found = i; break; }
            }
            if (found < 0) return 1;
            inv.selected = found;
            mc.player.drop(false);
            if (--guard <= 0) return 1;
            return 0;
        }
        public String detail() { return "已尽量丢弃物品（仅限快捷栏）"; }
    }

    private static class WaitTask implements Task {
        int ticks;
        WaitTask(int ticks) { this.ticks = ticks; }
        public int tick() { return (--ticks <= 0) ? 1 : 0; }
        public String detail() { return "等待结束"; }
    }
}
