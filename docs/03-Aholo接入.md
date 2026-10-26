# Aholo 接入方案

三条接入路径，按风险从低到高。**当前代码已实现路径 C 的资产管线，并为路径 A 预留了接入点。**

---

## 路径 A（最低风险）· Aholo Viewer + Lux3D 英雄资产

`@manycore/aholo-viewer` v1.11.0，**MIT 开源**，1109 ★，`github.com/manycoretech/aholo-viewer`。
**运行时不需要 API key、不消耗额度、没有速率限制。**

已确认的能力（来自官方手册与示例代码，非推测）：

- 手册明确它是 "general-purpose renderer for standard **Mesh** and 3DGS content"。
- `GLTFLoader.loadGLTF` 是公开导出。
- 官方 `walk-demo.ts` 同时执行 `scene.add(splatLayer)` 和 `scene.add(characterRoot)`，
  而 `characterRoot` 装的就是 GLB —— **3DGS 与 GLB 混合同一个 Scene3D 是官方用法**。
- 可行走模式 + voxel 碰撞是 `walk-demo.ts` 里的示例代码（85 KB），
  `ViewerWalkMode` / `VoxelCollision` **不是包导出**，需要 vendor 进仓库。
- 现成的「splat + voxel」配套场景可以直接拿来用，零成本得到一间**真实重建、可行走**的房间：
  ```
  https://holo-cos.aholo3d.cn/aholo-opensource/gs_file/room/voxel/10c88df3/collision.voxel-meta.json
  https://holo-cos.aholo3d.cn/aholo-opensource/gs_file/juguo/voxel/309eccc1/collision.voxel-meta.json
  （同名 .bin 是数据本体）
  ```

**这是本项目的 M3 目标**：把程序化的 `Room.ts` 换成真实重建空间，
游戏逻辑（`rules.ts` / `Game.ts`）完全不动 —— 它们只依赖槽位坐标，不关心房间是怎么来的。

### 注意

- glTF 的 PBR 材质"可能无法完整转换"，Aholo Viewer 基于 Phong。
  几何、贴图、骨骼动画没问题，**PBR 观感会掉**，需要重新调材质。
- splat 本身**没有碰撞**。可行走性来自额外的 voxel 数据，
  必须用 `@manycore/aholo-splat-transform` v2.0.2（MIT）的 `Voxel` 任务离线生成。

---

## 路径 B（中等）· 只用 Lux3D 网页版

黑客松**强制要求使用 Lux3D**，但 Aholo API 是可选的。

**风险**：免费额度的导出范围不明。`Export in all supported formats` 和
`Commercial use of generated models` 都列在 PRO 权益里（$14.9/月）。
如果导不出 GLB 或不能商用，需要开一个月 Pro。

---

## 路径 C（最高，已实现）· Aholo 开放 API

```
base    https://api.aholo3d.cn
auth    header  Authorization: <API key>      ← 没有 Bearer 前缀
信封    { c, m, d, f }                        ← c === "0" 才是成功
```

规范原文可直接下载，不用爬文档站：**https://labs.aholo.ai/api-docs/openapi.json**
（OpenAPI 3.0.3，30 个接口，98 个 schema。已存档在 `docs/research/spec/aholo-openapi.json`。）

### 异物生成管线（本项目使用）

```
POST /lux3d/v1/generate/text-to-3d/task/create
     { prompt, version:"G1", outputFormat:["glb"] }        -> { c:"0", d:<taskid> }
GET  /lux3d/v1/generate/task/get?taskid=<id>
     d.status:  0 初始化 · 1 运行中 · 3 成功 · 4 失败 · 6 已取消
     d.outputs[].content  —— G1 的顺序是 [ZIP, GLB]
```

**结果 URL 只有 2 小时有效期**，所以生成后必须立刻下载 —— `tools/generate-assets.mjs`
就是这么做的（先在内存里校验 `glTF` magic，再落盘）。

```bash
npm run assets:plan                 # 不需要 key，先看要生成什么
npm run assets:generate             # 需要 AHOLO_API_KEY
```

15 个异物的 prompt 写在 `data/foreign-assets.json`，**游戏和生成脚本读同一份数据**。
生成物落到 `public/assets/foreign/<key>.glb`，`src/game/assets.ts` 自动加载并
按 `height` 归一化尺寸、把底面重新对齐到 y = 0（生成结果没有统一比例和轴心，
不归一化的话"一盒牛奶"会有两米高）。

**没有资产时游戏照常可玩** —— 每个异物都有程序化占位模型。

### 其他可用接口（尚未接入）

| 接口 | 用途 |
| --- | --- |
| `POST /world/v1/reconstructions` | 图片/视频 → 3DGS 世界。**只要有图片输入就必须 ≥ 20 张**；纯视频可以绕过这一条。 |
| `POST /world/v1/generations` | SpatialGen：文字或单图 → 3DGS 世界（非室内场景是 Beta）。 |
| `POST /spatial-understanding/v1/tasks` | `.ply` 点云 → 语义 DSL（Wall / Door / Window / Bbox(class, pos, size)）。**可以用来决定异常该藏哪**，接入价值很高。 |
| `POST /rendercloud/v1/jobs` | OpenUSD 离线渲染；另有 WebSocket 实时流（服务端合成 3DGS + 高模）。 |
| `POST /lux3d/v1/articulation-animation/task/create` | 模型关节化 + 动画 —— 能让异常"动起来"。 |

### 已核实的风险

- **额度计费**：`BIZ_11003` / `BIZ_24002` 额度不足。
- **并发上限**：`GENERATION_CONCURRENCY_LIMIT_EXCEEDED`。所以生成脚本默认并发 2。
- **全局限流**：429 / `BIZ_11001`。客户端已带指数退避重试。
- **网关在国内**：`api.aholo3d.cn`，海外访问延迟自负。
- 官方 SDK（全部 MIT）：npm `@manycore/aholo-sdk-lux3d` / `-world` / `-asset`，
  PyPI `manycore-aholo-sdk-*`，Maven `com.manycoreapis:aholo-sdk-*`。
  本项目手写了浏览器友好的客户端（`src/aholo/client.ts`）以免引入 region 配置依赖；
  它的契约由 `tests/client.test.ts` 的 17 个测试锁住。

---

## 必须由人来做的事

1. **报名**：https://www.aholo.ai/hackathon/register —— 拿到注册赠送额度
   （团队额度只在**第一次团队确认时在场的成员**之间分配）。
2. **注册 Lux3D**：https://lux3d.aholo.ai/lux3d/home —— 提交**强制**要求。
3. **API key**：https://labs.aholo.ai/api-keys（走路径 C 才需要）。
4. **加入 Discord**：https://discord.gg/2fS3a5YACg （10 月 30 日晚有 kickoff 直播）。
5. **发 X**：带 `#Manycorehackathon`（评审 5% 看传播）。
6. 发布 demo 链接 / 录 demo 视频 / 写项目报告 PDF。

## 不要用的东西

**InteriorGS**（`huggingface.co/datasets/spatialverse/InteriorGS`）是受限数据集，
许可证为**仅限非商业研究/教育**，含禁止再分发条款，且适用中国法律。
可以把玩，但**不要提交进公开仓库**，也不要建立在它之上的商业叙事。

第一方替代品：Aholo 自己的 SpatialGen 和 `SpatialUnderstanding`，
成本更低且没有许可证问题。
