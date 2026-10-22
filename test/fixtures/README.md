Public, unauthenticated response fixtures captured on 2026-09-09:

- `page.pb`: https://capi.yangshipin.cn/api/oms/pc/page/PG00000004
- `programmes.pb`: https://capi.yangshipin.cn/api/yspepg/program/600001859/20260909

These are Protocol Buffer payloads, not JSON. The schema field numbers were checked
against the JavaScript shipped by https://www.yangshipin.cn/tv/home and its actual
browser network requests. Tests use snapshots so they do not need the live service.

Additional public responses captured on 2026-10-22:

- `cctv/cctveurope.json`, `cctv/cctvamerica.json`: CCTV's `getEpgInfoByChannelNew` API, programme date 20261022.
- `provincial/cztv-112.json`: `https://p.cztv.com/api/paas/program/112/20261022`, the official CZTV 之江纪录 schedule, including millisecond start times and durations.

Other provincial fixtures capture official Shanxi, Hebei, Jiangsu, Guangdong, Xinjiang, Shanghai and Guangxi programme responses on 2026-10-22. Selected programme timestamps are unchanged. Tests mock network and browser signing; live collection uses official broadcaster services only.

- `provincial/hntv-146.json`: Henan's `pubmod.hntv.tv/program/getAuth/vod/originStream/program/146/1792598400`, selected programme fields for 2026-10-22; its public website uses SHA-256 request signatures.
- `provincial/hnntv-3.json`: Hainan's `www.hnntv.cn/api/schedule/byDay?channelId=3`, retaining the 2026-10-22 day.
- `provincial/iqilu-25.json`: Shandong's `sdxw.iqilu.com/v1/app/play/program/qilu?channelID=25&date=2026-10-22`; this is the actual endpoint used by the current live page.
- `provincial/gdtv-invalid-duration.json`: normalized Guangdong Pearl official rows for 2026-10-23, including the original multi-day end of programme 294678155. Used to verify bounded quarantine without changing valid intervals.
- `provincial/iqilu-empty-placeholder.json`: official Shandong agricultural channel guide for 2026-10-22, including its blank zero-airtime trailing table cell.
- `provincial/fjtv-zhpd.json`: selected original fields from Fujian's `mapi-plus.fjtv.net/cloudlive-manage-mapi/api/topic/program/list`, topic 665248990102917120, date 2026-10-22.
- `provincial/snrtv-1.txt`: unexecuted JavaScript response from `qidian.sxtvs.com/api/v3/program/tv?channel=1`; HTTP Date at capture was `Thu, 22 Oct 2026 02:27:11 GMT`. Clock-only programmes are limited to that server day.
- `provincial/snrtv-star.txt`: the same official endpoint with `channel=star`, including two different titles assigned to the identical 07:00–07:29 interval. Tests retain both labels without fabricating internal times.
- `provincial/yntv-dushi.json`: selected original programme fields from `yntv-api.yntv.cn/index/jmd/getJmd?name=yunnandushi&da=2026-10-22`, read in the official page's headless browser context. Includes the first programme starting at 00:00:01 and the last explicit duration with null `endtime`.
- `provincial/qhbtv-jingji.json`: selected original fields from Qinghai's `mapi.qhbtv.com.cn/cloudlive-manage-mapi/api/topic/program/list`, topic 786227316454875136, date 2026-10-22.
- `provincial/setv.json`: original `time`, `title`, and `display` fields from `api.setv.sh.cn/getLatestEPG`. The API array is not chronological; tests sort actual starts and do not invent an end for the latest start.

- `provincial/nxtv.json`: selected original response fields from `https://api.ningxiahuangheyun.com/?mod=get_appdata&appid=nxtv-tv`, fetched on 2026-10-22; all 97 programmes from the official Ningxia satellite, public and culture/travel guides, with unchanged timestamp and date fields. This endpoint is referenced by the broadcaster public/culture channel pages.

- `provincial/hbtv-{204,338,339,178,180,340}.json`: original official Changjiangyun TV responses for six Hubei channels, captured 2026-10-22 from `cjy-iptv.hbtv.com.cn/wxcms3/remote-wx/api/cj-cloud/play/null/show`; channel codes verified against its official channel list and anonymous request configuration verified in `res.cjyun.org/t/common/app/iptv/`. Start/end seconds and overnight dates are unchanged.
