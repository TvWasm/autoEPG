# XMLTV 接入约定

订阅入口：`https://github.com/TvWasm/autoEPG/releases/latest/download/epg.xml`。
它是未压缩的 UTF-8 XML，仅包含与当天相交的节目。日期以北京时间为准。
未来数据使用日期版本的 `epg.xml`，例如 `/releases/download/2026-09-10/epg.xml`。

当天 Latest 另提供 `epg2.xml`（今天和明天）及 `epg3.xml`（今天、明天和后天），路径分别为 `/releases/latest/download/epg2.xml` 和 `/releases/latest/download/epg3.xml`。它们与单日文件使用相同频道 ID、PNG 台标和时间格式；合并后的每个节目只输出一次。

## 标准字段

| XMLTV 字段 | 约定 |
| --- | --- |
| `tv` | 标准根节点；所有 `channel` 在所有 `programme` 之前 |
| `tv/@source-info-name` | 完整文件为 `央视频`，分组文件为 `央视频道` 或 `卫视频道` |
| `channel/@id` | 固定小写 ID，例如 `cctv3`、`hunanweishi`；以映射表为准，区分大小写 |
| `channel/display-name` | 第一项为规范名称，后续为源站名称及常用别名；不要将多个名称视为不同频道 |
| `channel/icon/@src` | 可直接请求的 PNG URL；不需要 Cookie 或 Referer |
| `channel/url` | 央视频对应频道页面，不是直播流 |
| `programme/@channel` | 引用已声明的 `channel/@id` |
| `programme/@start`、`@stop` | `YYYYMMDDhhmmss +0800`，包括秒及显式时区；结束时间为开区间 |
| `programme/title` | 保留源站标题并正确转义；包含汉字时标记 `lang="zh"`，其他标题省略无法确认的语言标记 |

示意（台标地址为占位示例）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="autoEPG" source-info-name="央视频">
  <channel id="cctv1">
    <display-name lang="zh">CCTV1</display-name>
    <display-name lang="zh">CCTV-1</display-name>
    <icon src="https://example.com/cctv1.png"/>
  </channel>
  <programme start="20260909190000 +0800"
             stop="20260909194000 +0800" channel="cctv1">
    <title lang="zh">新闻联播</title>
  </programme>
</tv>
```

## 时间与匹配

- 匹配频道时，优先让 M3U 的 `tvg-id` 等于 XML 的频道 ID。按名称匹配只能作为应用自己的回退策略。
- 时间已经带 `+0800`，解析为绝对时间后不要再额外加八小时。判断正在播放时使用 `start <= now < stop`。
- 跨午夜节目不会被截断或拆成假节目，可能出现在相邻日期的 XML 中。合并多天数据时用 `(channel, start)` 去重。
- 频道先按央视、卫视分组，再按配置顺序排列；节目遵循频道顺序，同频道按开始时间排列。没有节目简介、类型、演员等源数据时省略这些可选字段，不生成猜测信息。
- 去除 XML 1.0 禁止的控制字符；标题里的 `&`、`<` 等由 XML 序列化器转义。程序需使用 XML 解析器，避免用正则表达式提取节目。
- 源站的零时长记录（`start == stop`）不输出为节目，处理详情见 `manifest.json` 的 `discardedProgrammes`。不推测结束时间，不改变相邻有效节目的标题和时间；负时长、异常日期及持续冲突会排除对应频道日期，正常源继续发布。

## 下载与刷新

支持 HTTPS 重定向并允许短暂失败重试。零点 Actions 需要执行时间，Latest 在当天数据完成校验、发布后切换；失败时保留最后成功版本。客户端可通过该版本的 `manifest.json` 中 `date`、`generatedAt` 判断新鲜度，不应仅凭 `latest` URL 假设一定已更新。

工作流每四小时尝试刷新。央视频、央视网通过独立核心任务优先发布，随后省台任务补充。每频道每日以本轮有效数据为先，失败时可使用同日期已发布数据。`snapshot.json` 随每日版本发布并纳入校验和；`manifest.json` 的 `fallbackUsage` 记录复用批次及原始抓取时间，缓存不会修改节目播出日期或更新时间。首次升级可从已校验的历史 XML 及频道清单恢复。其他日期的上传失败不阻止今天已经成功发布的文件继续使用。

默认允许部分源失败后继续发布。`manifest.json` 的 `partial` 表示本轮存在错误或告警，`failures` 列出来源、频道、日期、阶段和原因，`warnings` 记录低覆盖等情况；不能把“版本已更新”等同于所有源正常。只有导出为空、当天没有有效节目、文件校验失败或发布本身失败才停止切换。源错误在发布后的独立检查作业中默认只告警，不阻止正常数据发布或将工作流标红；生成、发布或报告读取真正失败时仍报错。完整 HTML/文本/JSON 诊断日志见 epg-diagnostics 构件，保留 14 天。

`channels.json` 中 `id`、`name`、`aliases`、`logo` 与 XML 一致，供壳应用建立映射。`sourceName` 是源站原名，`pid` 是源站标识，`dates` 是源站公布的日期。

`groupId` 为 `cctv` / `weishi` / `provincial`，`group` 为 `央视频道` / `卫视频道` / `省级频道`。`groups.json` 提供每组的 `channelIds` 和 `feeds`（文件名、天数、日期范围等）。XMLTV 官方 DTD 没有频道分组字段，分组信息放在 JSON 中；只读取 XML 的应用可选择 `epg-cctv.xml`、`epg-weishi.xml`、`epg-provincial.xml`，当天另有 `epg2-<groupId>.xml` 和 `epg3-<groupId>.xml`。每份 XML 自含频道定义，符合相同标准。已有卫视保留原 ID、分组；新增频道的固定 ID 和名称别名见 `src/provincial-channels.json`。省级新增频道没有可靠 PNG 台标时省略 `icon`。

`provincial-coverage.json` 是省级台目标目录的实际覆盖报告，随每日 Release 发布并纳入 `SHA256SUMS`。报告区分既有卫视、新增有节目数据频道、当前缺失频道，列出实际可用日期；不能把 `targetCount` 当作已经发布的频道数。只使用电视台官网及其官方接口。既有卫视如有官网适配，整日优先选官网，未公布日期再选央视频，`officialDates` 记录官网日期。待实现的适配、获取失败和官网合法空列表分别记录；缺少官方结束时间依据及少量广东超长区间写入 `omittedProgrammes`，不编造时间补齐。广东隔离上限为每频道每日 2 条且不超过记录数的 10%，否则排除该频道日期并报错。浙江官方接口返回的 station-0 通用占位节目不导出。

`manifest.json` 的 `scheduleRechecks` 记录因源站冲突触发的重读及原冲突内容，`requestCount` 包含重读和本轮跳过的任务。最多重读两轮；持续冲突只排除受影响的频道日期，不按顺序任意保留节目。排除内容写入 `failures`，其他频道继续发布。

陕西仅有时分的当前节目表按官网 HTTP `Date` 限定当天，不能用来补历史或未来。官网同一精确起止区间列出多个标题时，XML 标题保留为 `标题一 / 标题二`，覆盖报告的 `combinedProgrammes` 保留原始标题和时间；不推断块内的播出顺序或边界。

频道映射版本 `channelSchemaVersion` 现为 2，见 `manifest.json`、`groups.json`。旧 `ysp.<PID>` ID 通过频道的 `legacyIds` 映射到新 ID，迁移后请同步更新 M3U 的 `tvg-id`。例如 `ysp.600001859` → `cctv1`。CCTV5+ 为 `cctv5plus`，CCTV16 高清和 4K 分别为 `cctv16`、`cctv164k`，不会合并不同频道。

格式依据：[XMLTV 官方 DTD](https://github.com/XMLTV/xmltv/blob/master/xmltv.dtd)。ID 是 XMLTV 自由字符串；可读命名和多个 `display-name` 都属于标准用法。
