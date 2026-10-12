# forge-bot 通信协议 v1（Node AI ⟷ Forge 客户端 mod）

传输：**TCP，127.0.0.1:8765**，UTF-8，**换行分隔的 JSON**（每条消息一行）。
角色：**mod = 服务端（listen）**，**Node AI = 客户端（connect）**。

## 消息类型

### Node → mod：请求执行一个动作
```json
{"t":"action","id":12,"name":"dig","args":{"x":10,"y":64,"z":-3}}
```
- `id`：自增，用于配对回执。
- `name`：动作名（见下）。
- `args`：动作参数。

### mod → Node：动作回执
```json
{"t":"result","id":12,"ok":true,"detail":"已挖掉 oak_log"}
{"t":"result","id":13,"ok":false,"detail":"目标位置没有方块"}
```

### mod → Node：状态推送（约 5 Hz）
```json
{"t":"state","data":{ ...见下... }}
```

### 心跳
- Node → mod：`{"t":"ping"}`
- mod → Node：`{"t":"pong"}`

## 状态 data 字段（mod 尽量填全，缺的用 null）
```json
{
  "pos": {"x":0,"y":64,"z":0},
  "yaw": 0.0, "pitch": 0.0,
  "health": 20, "food": 20, "oxygen": 20, "xpLevel": 0,
  "onGround": true, "inWater": false, "onFire": false,
  "dimension": "minecraft:overworld",
  "timeOfDay": 1000, "raining": false, "thundering": false,
  "held": {"name":"iron_pickaxe","count":1},
  "inventory": [{"name":"oak_log","count":3,"slot":36}],
  "players": [{"name":"Steve","x":1,"y":64,"z":2,"dist":2.2}],
  "entities": [{"name":"zombie","type":"mob","x":5,"y":64,"z":5,"dist":7.1}],
  "blocks": [{"name":"oak_log","x":3,"y":64,"z":4,"dist":5.0}],
  "chat": [{"user":"Steve","msg":"你好"}]
}
```
- `blocks`：可选的“附近值得注意的方块”采样（mod 端跑 find 类逻辑或直接由 Node 发起 `scan`）。
- `chat`：最近若干条聊天。

## 动作名 v1（mod 实现它支持的部分；不支持就回 `ok:false` 并说明）
移动：`move_to{x,y,z}` `move_near{target,name,distance}` `move_dir{direction,seconds}` `jump` `sprint{on}` `stop`
视角：`look_at{x,y,z}` `look_at_entity{target}` `turn{yaw,pitch}`
交互：`dig{x,y,z}` `place{x,y,z,block}` `use_item` `use_on{x,y,z}` `attack{target,times}` `pickup` `drop{item,count}` `equip{item,destination}`
物品：`swap_slots{a,b}` `get_inventory`
社交：`chat{message}` `whisper{player,message}` `follow{target,distance}` `stop_follow`
感知：`scan_area{radius}` `find_block{name,radius}` `find_entity{name,radius}`
世界：`sleep_in_bed` `open_door{x,y,z}` `close_door{x,y,z}` `press_button{x,y,z}`
其他：`wait{seconds}` `idle`

> 约定：mod 端只做“手脚”（真实客户端 API），**不做任何决策**；一切决策来自 Node 端的 LLM 闭环。
