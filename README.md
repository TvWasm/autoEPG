# autoEPG

自动获取[央视频电视页](https://www.yangshipin.cn/tv/home)节目单，并从央视网补充 CCTV4 欧洲版、美洲版，通过省级电视台官网及其官方接口补充省级频道，每日生成标准 **XMLTV EPG**，按日期发布到 GitHub Releases。无需服务器、央视频账号或个人访问令牌。

## 当天订阅

**[https://github.com/TvWasm/autoEPG/releases/latest/download/epg.xml](https://github.com/TvWasm/autoEPG/releases/latest/download/epg.xml)**

此固定地址只提供当天节目单，文件是未压缩的 UTF-8 XML，没有 `.gz`。播放器需要支持 HTTPS 重定向。

当天 Latest 同时提供三个固定入口，按需要选择：

| 文件 | 日期范围 | 订阅链接 |
| --- | --- | --- |
| `epg.xml` | 今天 | [单日](https://github.com/TvWasm/autoEPG/releases/latest/download/epg.xml) |
| `epg2.xml` | 今天、明天 | [两日](https://github.com/TvWasm/autoEPG/releases/latest/download/epg2.xml) |
| `epg3.xml` | 今天、明天、后天 | [三日](https://github.com/TvWasm/autoEPG/releases/latest/download/epg3.xml) |

三份文件都是独立、未压缩的标准 XMLTV，每日一起刷新。未来日期尚未公布的节目不会凭空补齐，实际范围和节目数见 `manifest.json` 的 `variants`。

## 日期版本

版本号和 tag 均为 `YYYY-MM-DD`，每个版本内的文件都叫 `epg.xml`。例如北京时间 2026-09-09：

| 版本 | 发布状态 | 文件内容 |
| --- | --- | --- |
| `2026-09-08` | 历史正式 Release | 9 月 8 日节目 |
| `2026-09-09` | 正式 Release，**Latest** | 9 月 9 日节目 |
| `2026-09-10` | **Pre-release** | 9 月 10 日节目 |
| `2026-09-11` | **Pre-release** | 9 月 11 日节目 |

指定日期的固定下载格式：

```text
https://github.com/TvWasm/autoEPG/releases/download/2026-09-09/epg.xml
```

到 9 月 10 日刷新时，`2026-09-10` 转为正式版并设为 Latest，9 月 9 日保留为历史版。源站调整节目后，刷新会**替换同日期版本的附件**，不会再创建按运行次数编号的版本。

版本从早到晚依次发布，并使用日期注解标签（标签时间为节目日期的北京时间零点），使 Release 页面按日期从新到旧排列；Latest 独立指定为当天，未来版本仍为 Pre-release。标签日期表示节目单日期，实际抓取时间见 `manifest.json`。

每个日期版本附带 `channels.json`（频道映射）、`manifest.json`（节目数、文件大小、更新时间、数据覆盖情况）和 `SHA256SUMS`（校验和）。每个 XML 独立包含所需频道定义；与该日期相交的跨午夜节目保留真实起止时间，因此边界节目可能出现在相邻两天的文件中。

## 更新规则

[Update EPG 工作流](https://github.com/TvWasm/autoEPG/actions/workflows/epg.yml) 每天北京时间 **00:00** 运行一次，对应 UTC `0 16 * * *`。GitHub 排队可能延迟，尤其是整点，文件不保证零点整完成发布。

- 默认刷新过去 3 天、今天和未来 3 天，以源站实际公布的日期为准。范围之外的已发布历史版本保留。
- 每日自动抓取包含 `CCTV4(欧)` 和 `CCTV4(美)`，随完整 EPG、央视频道分组及两日/三日订阅一起发布，无需单独运行脚本。
- 省级台收录范围来自下文的固定频道目录，已有卫视保留原 ID，新增频道随每日完整、两日、三日 EPG 及省级分组发布。每次附带 `provincial-coverage.json`，区分实际收录与暂时缺少数据的频道，不把空频道算作完成收录。
- 动态发现频道及节目日期；额外读取起始日前一天，补全跨午夜节目。
- 未来日期只发布为 Pre-release，不会抢占 Latest。
- 支持 Actions → Update EPG → Run workflow 手动刷新；推送 `main` 后也会测试并刷新，PR 仅测试。
- 默认按源、频道和日期隔离失败：请求失败、错误格式、异常时间或持续冲突只排除受影响的频道日期，继续发布正常数据。每个请求最多尝试 3 次，最多 4 个并发；某个源连续 3 次发生网络/授权故障后，本轮跳过其后续请求，避免占满抓取时限。合法空节目单单独记录，不当作请求错误。
- 少于 50 个频道或当日覆盖率低于 90% 只告警，不阻止其他源发布。`manifest.json` 的 `partial`、`failures`、`warnings` 明确记录降级情况。没有有效节目或没有任何与当天相交的有效节目时停止发布，保留上次版本；不会用旧日节目冒充当天。
- Actions 中仅在整轮无法导出时最多重试 3 次，间隔 30 秒、60 秒，抓取步骤总计限时 12 分钟。有效数据完成校验后先发布，再由独立检查作业汇总错误并报错，触发 GitHub 默认通知；已发布 EPG 保留。
- 源站调整节目时可能遗留开始、结束时间相等的零时长记录。仅跳过这些没有播出区间的记录，保留有效节目原始时间；日志会提示数量，`manifest.json` 的 `discardedProgrammes` 记录频道、日期、源节目 ID、标题、时间和原因。清理后的数据仍需通过覆盖率及冲突检查。

发布时先检查所有文件的校验和，再将新附件上传到临时名称；上传成功后替换公开名称，最后更新版本状态。替换失败会尝试恢复旧名称，原文件在完成切换前保留。GitHub 不支持多个附件原子切换，重命名期间可能有短暂下载间隙，客户端可重试。临时附件在成功后清理。新版本在文件上传完成前保持草稿状态。

同日期版本需要可修改附件，请**不要启用 Release immutability（版本不可变）**。若组织策略禁止工作流写仓库，需要允许发布作业的 `contents: write`；发布使用自带的 `GITHUB_TOKEN`，报错通知使用 GitHub 默认通知，无需额外 Secrets。Fork 后需启用 Actions，并修改本文订阅链接的仓库名。

需要彻底重建版本列表时，可手动运行 Actions 并勾选 `rebuild_releases`。它会在新数据抓取、校验通过后，删除所有 Release 及其关联标签，再按日期重建。该选项默认关闭，日常定时刷新不会删除历史版本。

## 播放器频道匹配

频道 ID 使用固定的小写英文或拼音，例如 `cctv3`、`cctv5plus`、`hunanweishi`；`channel/@id` 与 `programme/@channel` 完全一致。显示名称包含 `CCTV3`、`CCTV-3`、`央视综艺` 等别名，`channels.json` 同步提供 `aliases`。尚未配置的新频道暂用 `ysp<PID>`。支持按名称匹配的播放器可使用别名；精确匹配应设置 M3U 的 `tvg-id`：

```m3u
#EXTM3U
#EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV1" group-title="央视频道",CCTV1
https://your-stream-provider.example/cctv1.m3u8
```

播放地址为占位示例，本项目只提供节目单。

本次频道映射升级为版本 2，旧的 `ysp.<PID>` 已改为上述 ID；已接入的应用可通过 `channels.json` 的 `legacyIds` 迁移，并更新 M3U 的 `tvg-id`。ID 区分大小写。命名和别名参考了 [老白 EPG](https://laobaiepg.laobaitv.net/guide_mainland.xml)（2026-09-09），映射表保存在 `src/channel-profiles.json`，运行时不依赖该服务。

## 频道分组

包含省级补充源时，主文件的 `source-info-name="央视频 / 央视网 / 省级 EPG"`，频道按“央视频道”“卫视频道”“省级频道”排列。XMLTV 没有标准的频道分组字段，因此不添加自定义 XML 字段；应用可读取 [channels.json](https://github.com/TvWasm/autoEPG/releases/latest/download/channels.json) 的 `groupId`、`group`，或 [groups.json](https://github.com/TvWasm/autoEPG/releases/latest/download/groups.json) 的频道 ID 列表和订阅文件索引。

只需一类频道时，可订阅独立的标准 XMLTV 文件；分组文件的 `source-info-name` 为对应分组名称：

| 分组 | 今天 | 今天、明天 | 今天、明天、后天 |
| --- | --- | --- | --- |
| 央视频道（`cctv`） | [epg-cctv.xml](https://github.com/TvWasm/autoEPG/releases/latest/download/epg-cctv.xml) | [epg2-cctv.xml](https://github.com/TvWasm/autoEPG/releases/latest/download/epg2-cctv.xml) | [epg3-cctv.xml](https://github.com/TvWasm/autoEPG/releases/latest/download/epg3-cctv.xml) |
| 卫视频道（`weishi`） | [epg-weishi.xml](https://github.com/TvWasm/autoEPG/releases/latest/download/epg-weishi.xml) | [epg2-weishi.xml](https://github.com/TvWasm/autoEPG/releases/latest/download/epg2-weishi.xml) | [epg3-weishi.xml](https://github.com/TvWasm/autoEPG/releases/latest/download/epg3-weishi.xml) |
| 省级频道（`provincial`） | [epg-provincial.xml](https://github.com/TvWasm/autoEPG/releases/latest/download/epg-provincial.xml) | [epg2-provincial.xml](https://github.com/TvWasm/autoEPG/releases/latest/download/epg2-provincial.xml) | [epg3-provincial.xml](https://github.com/TvWasm/autoEPG/releases/latest/download/epg3-provincial.xml) |

原有频道分组跟随央视频源站分类（包括源站归入卫视频道的 CETV1）。新补充频道进入“省级频道”，其中也可能包括央视频尚未提供的卫视；已有卫视继续位于“卫视频道”，不重复创建。日期版本也提供单日分组文件。分组和完整文件使用相同的频道 ID、别名及已配置台标；没有可靠 PNG 台标的新增频道暂不输出 `icon`。

台标链接统一为真正的 PNG。CCTV 的 34 个频道使用项目内 [assets/logos](assets/logos/README.md) 的银白渐变透明台标，通过本仓库 Raw 地址提供；每次生成校验本地文件签名和 SHA-256。CGTN、卫视频道继续使用源站 PNG，移除 WebP 转换参数，并通过无登录、无 Referer 的请求验证 PNG 签名。图片不内嵌到 XML，避免增加体积。XMLTV 字段、频道关联和跨日语义见 [接入说明](docs/xmltv.md)。

## 免费额度

本仓库是公开仓库，使用标准 `ubuntu-latest` 运行器，**Actions 运行时间免费**。私有仓库的 GitHub Free（包括免费组织）每月包含 **2,000 分钟**及 **500 MB Actions 构件存储**。Larger runners 即使在公开仓库也收费。本项目不使用 Larger runners 或依赖缓存，只保存小型运行报告构件 7 天，用于发布后的异常检查。[官方计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

Release 附件与 Actions 构件不同。单个 Release 附件需小于 2 GiB，每个 Release 最多 1,000 个附件，官方未限制 Release 总大小和带宽用量。[Release 限额](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#storage-and-bandwidth-quotas)

若一次运行的两个作业合计 5 分钟，每天一次、30 天约 150 分钟；实际以 Actions 耗时为准。公开仓库不消耗私有仓库的 2,000 分钟配额。

公开仓库 60 天无仓库活动时，定时工作流可能自动停用；不要假设自动运行或发布 Release 必然避免停用。若订阅长期未更新，请查看 Actions 并重新启用工作流。[官方 schedule 说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## 本地运行

需要 Node.js 22 或更新版本；Actions 使用 Node.js 24。

```sh
npm ci
npx playwright install chromium
npm test
npm run generate
```

输出为 `dist/YYYY-MM-DD/epg.xml` 和对应元数据；当天目录另有 `epg2.xml`、`epg3.xml`。`dist/releases.json` 列出本轮可发布的日期、附件及单日 XML 大小，不输出 Gzip。显式缩短本地日期范围时，只生成该范围可以覆盖的订阅文件。

```sh
npm run generate -- --past-days 1 --future-days 3 --concurrency 2 --output dist
npm run generate -- --date 2026-09-09 --past-days 0 --future-days 0
```

指定日期受源站保留范围约束；手动生成的历史数据不会被发布脚本误设为当天 Latest。默认允许部分源失败后继续导出。需要排查源站时可加 `--strict`，恢复整轮失败及覆盖率硬性检查；每日工作流不使用这个选项。其他参数见 `npm run generate -- --help`。

## 发布后 GitHub 默认报错通知

有效数据先发布，`notify` 独立作业随后读取运行报告。有源错误或质量告警时，该作业把来源、频道、日期和原因写入运行摘要，并以失败状态结束，触发 GitHub 默认工作流通知。已发布的 EPG 不会回滚；整轮工作流标红时，请同时查看 `publish` 作业和 Release 的发布结果。

无需配置发信账号、密码或额外 Secrets。邮件接收地址与发送条件沿用你的 [GitHub Actions 通知设置](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)，可选择只接收失败通知。GitHub 邮件链接到运行记录，异常明细在运行摘要和报告构件中。

正常无错误、无告警时检查通过。长期未接通频道和合法未公布的未来节目不作为错误；隔离的异常区间会告警。检查也覆盖生成失败、发布失败、测试失败和报告缺失，无法确认发布结果时明确标为“未确认”。

`run-report.json` 作为 Actions 构件保留 7 天，源错误同时记录到 Release 的 `manifest.json`。

## 数据来源与验证

### 省级台频道

[省级频道目录](src/provincial-channels.json) 根据 [webSourceM3U8/webview.txt](https://github.com/buhanzhe/webSourceM3U8/blob/main/webview.txt) 的 2026-10-22 列表整理，包含省级台、直辖市台旗下频道，不含市县台；同播清晰度、同一频道的多个地址合并。原列表整理出 225 个目标频道，另根据官网补充宁夏公共、宁夏文旅，当前目录共 227 个频道；新增 ID 固定保存在目录中，名称和别名用于播放器匹配。日常运行读取本地目录，不执行播放列表中的 JavaScript 或 `ujs` 参数。

已有目标卫视保留频道 ID、分组和台标；已有官网适配的卫视按日期优先使用该台官网完整节目单，官网未公布的日期再使用央视频。不会将两个来源的同日节目混合。新增频道只使用电视台官网及官网调用的接口，不使用第三方 EPG。

已接通浙江、山西、河北、江苏、广东、新疆、上海、广西、河南、海南、山东、福建、陕西、云南、青海、宁夏、湖北及上海教育台的官方节目接口。广东通过 Playwright 无头 Chromium 打开官网，使用官网签名模块请求节目接口；云南优先在无头浏览器页面中请求官网日期接口，浏览器遇到网络或跨域错误时，再带官网请求头直连同一官方接口；其余直接请求官网接口。官网接口或签名变更会明确失败，不切换第三方源。GitHub Actions 自动安装 Chromium，本地首次运行也需安装浏览器。

湖北节目来自长江云 TV 官方公开网页调用的按日期节目接口，匿名请求配置从网页脚本读取，已核验卫视、经视、综合、影视、教育、垄上六套频道；公共、生活接口目前为空，仍每日检查，有节目时自动收录，长期空表不触发覆盖率告警。保留官方秒数和跨日结束时间。

宁夏官网调用黄河云接口，一次返回卫视、公共、文旅三套频道的当天节目；同时校验日期文本与秒级时间戳，未公布日期不复制当天节目。

陕西官网接口仅提供当天时分节目表，使用响应的 HTTP `Date` 确认北京时间日期，只收录当天，不将其用于历史或未来日期。同一节目块被官网赋予多个标题且起止时间完全相同时，保留全部标题为 `标题一 / 标题二`，原始标题列表及区间记录在 `combinedProgrammes`，不推断块内边界；不同起止时间的冲突仍严格校验。福建使用新版官网的匿名商户配置及带明确日期、秒级起止时间的节目接口。山东官网导出的空白零时长表格占位行单独审计，不当作节目。

**227 个目录频道尚未全部接通。** `provincial-coverage.json` 区分 `existing`、`imported`、`fetch-failed`、`no-published-schedule` 和 `official-adapter-pending`，列出官方页面、来源、失败日期和实际日期；不能把目录数量当作实际覆盖数量。待接通频道需要逐台实现官网适配。已配置且通常公布节目的频道，当天缺少节目或覆盖率不足会告警；官方长期空节目页单独标记，不计入该分母。

已检查但未接通入口的具体情况见[官网适配调查记录](docs/official-source-research.md)。上海教育台的列表按实际开始时间排序，以后续真实开始时间确定区间，最后一条没有可靠结束依据时记入审计，不使用播放链接中可能延伸到次日的回看窗口补节目。

节目保留官方起止时间。广西无时长记录仅在有下一条真实开始时间时确定结束；缺少结束依据的记录写入覆盖报告的 `omittedProgrammes`。广东官网偶发的超过 24 小时区间，仅在每频道每日最多 2 条且不超过当天记录 10% 时隔离，并记录原始标题、起止时间及原因，不推算结束时间；超过限额则排除该频道日期并报错，其他格式及时间校验仍严格执行。合法空列表、未公布未来日期和浙江 station-0 通用占位节目不用于填充 EPG。

同一频道同一开始时间出现冲突时，最多重新请求相关日期 2 次；省台重读绕过预抓取缓存，重新创建并关闭所需浏览器资源。新的完整响应替换先前响应，不按记录顺序或节目 ID 挑选胜者。持续冲突排除对应频道日期，保留其他数据，并写入 `manifest.json` 的 `failures` 和 `scheduleRechecks`。

CCTV4 欧洲版、美洲版使用各自直播页实际调用的公开 JSON 接口 `https://api.cntv.cn/epg/getEpgInfoByChannelNew?c=<channel>&serviceId=tvcctv&d=<YYYYMMDD>`，频道参数分别为 `cctveurope`、`cctvamerica`。对应 XMLTV ID 为 `cctv4europe`、`cctv4america`，显示名称和别名包含 `CCTV4(欧)`、`CCTV4(美)`，归入央视频道并共用 CCTV4 台标。节目起止时间保留源站秒级时间，输出为北京时间；未公布日期记录为空，不使用亚洲版节目代替。`manifest.json` 的 `sources` 同时记录央视频和两个央视直播页。

央视频部分使用电视页实际请求的公开接口，无需运行浏览器：

1. `https://capi.yangshipin.cn/api/oms/pc/navigation/home_top_nav`：发现电视栏目。
2. `https://capi.yangshipin.cn/api/oms/pc/page/<feedId>`：发现频道及节目日期。
3. `https://capi.yangshipin.cn/api/yspepg/program/<pid>/<YYYYMMDD>`：获取节目单。

接口返回 Protocol Buffers，`src/yangshipin.proto` 的字段编号来自网站公开前端 schema，使用 protobufjs 解码，不执行远程 JavaScript。接口改版或网络限制可能需要调整适配器。

输出遵循 [XMLTV DTD](https://github.com/XMLTV/xmltv/blob/master/xmltv.dtd)，使用显式 `+0800` 并保留秒级时间。离线测试覆盖真实响应快照、日期边界、XML 转义、去重、重试、并发、覆盖率、按日拆分、校验和、日期版本、Pre-release 晋升、覆盖更新和失败回滚。

### 收到 Run failed 邮件时

先查看 Actions 的作业结果：`test` 和 `publish` 成功、`Source errors after EPG publication` 失败，表示正常 EPG 已发布，但有部分源异常；失败通知是发布后的检查触发的。具体来源、HTTP 状态及网络错误原因在该作业摘要和 `epg-run-report` 构件中。GitHub 运行器与本地网络不同，本地成功不保证线上可达。不要用关闭错误检查来掩盖缺失频道。

### 省台接口在 GitHub 运行器上持续超时或拒绝访问

可注册一台能正常访问这些官网的国内 Ubuntu 22.04/24.04 Linux 自托管运行器，标签设为 `epg-cn`，然后在仓库 Settings → Secrets and variables → Actions → Variables 设置 `EPG_PUBLISH_RUNNER=epg-cn`。仅抓取/发布作业使用该标签；测试和通知仍在 GitHub 托管运行器执行。运行器应在线，并允许工作流安装 Chromium 系统依赖。未配置变量时继续使用 `ubuntu-latest`，不会自动安装或注册运行器。

此选项改变请求发出的网络位置，不替换官方节目源。配置运行器后仍需检查实际报告；无法保证某台运行器一定获源站允许。[GitHub 运行器配置文档](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow)
