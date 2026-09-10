/**
 * LyricManager — 歌词获取 & 逐行追踪
 *
 * 通过 pluginManager 获取歌词源，使用 LyricParser 解析，
 * 播放进度变化时更新当前歌词行并写入 jotai atom。
 */
import LyricParser from '@common/lyricParser';
import { compositeKey } from '@common/mediaKey';
import { LOCAL_PLUGIN_NAME } from '@common/constant';
import pluginManager from '@infra/pluginManager/renderer';
import mediaMeta from '@infra/mediaMeta/renderer';
import appConfig from '@infra/appConfig/renderer';
import { store, currentLyricAtom, progressAtom, associatedLyricAtom } from './store';

/** 歌词偏移写入 mediaMeta 的防抖延迟（ms） */
const OFFSET_PERSIST_DELAY = 500;

/** 自动搜索时每个插件取前 N 条候选做匹配 */
const AUTO_SEARCH_CANDIDATE_LIMIT = 5;
/** 自动关联的最低匹配分 */
const AUTO_SEARCH_MIN_SCORE = 60;
/** 参与匹配的候选上限（跨插件汇总后） */
const AUTO_SEARCH_MAX_CANDIDATES = 8;

/** 文本归一化：仅保留中文、字母与数字，用于标题/歌手匹配 */
function normalizeText(text: unknown): string {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[^一-龥a-z0-9]/g, '');
}

/** 视频/合集常见噪声词，提取歌名后用于清洗 */
const NOISE_WORDS = [
    'hi-res',
    'hires',
    'lossless',
    'official audio',
    'official mv',
    '4k',
    '8k',
    '无损音质',
    '无损音乐',
    '无损',
    '音质',
    '百万录音棚',
    '录音棚',
    '大声听',
    '纯享',
    '歌词版',
    '高清',
    '高品音质',
    '超品音质',
    '母带',
    '杜比全景声',
    '杜比',
    '全景声',
    '合集',
    '精选',
    '歌曲精选',
    '地表最高音质',
    '顶级文案',
];

/** 看起来像频道/UP主名而非歌手名 */
const CHANNEL_NAME_RE =
    /合集|精选|工作室|studio|records|record|频道|官方|官网|影视|传媒|出品|音乐分享|无损|音质|录音棚/i;

interface ExtractedMeta {
    title: string;
    artist: string;
}

/**
 * 从噪声标题中提取真实歌名与歌手。
 * 适配："001. 夜曲-周杰伦"、"【4K|Hi-Res】《Young For You》 - GALA"、
 *      "王艳薇《离开我的依赖》百万豪装录音棚大声听" 等视频命名。
 */
export function extractSongMeta(rawTitle: unknown, rawArtist?: unknown): ExtractedMeta {
    const work = String(rawTitle ?? '').trim();
    let title = '';
    let artist = '';

    const cleanPart = (s: string) =>
        s
            .replace(/[[【（(][^\]】）)]*[\]】）)]/g, ' ')
            .replace(/^\s*\d{1,3}\s*[.、\-_]?\s*/, '')
            .trim();

    const plausibleArtist = (s: string): boolean => {
        const t = s.trim();
        if (!t || t.length > 16 || CHANNEL_NAME_RE.test(t)) return false;
        // 2-4 个中文字符，或简短英文名（至多 2 个单词）
        return /^[一-龥·]{2,4}$/.test(t) || /^[a-z0-9.'&]+(\s+[a-z0-9.'&]+)?$/i.test(t);
    };

    // 1. 优先取《...》中的歌名
    const bookMatch = /[《〈「]([^》〉」]{1,60})[》〉」]/.exec(work);
    if (bookMatch) {
        title = bookMatch[1].trim();

        const before = cleanPart(work.slice(0, bookMatch.index));
        if (plausibleArtist(before)) artist = before;

        if (!artist) {
            const after = work.slice(bookMatch.index + bookMatch[0].length);
            const tail = after
                .split(/[-—–_|:：]/)
                .map((s) => s.trim())
                .find(plausibleArtist);
            if (tail) artist = tail;
        }
    } else {
        // 2. 去括号噪声、去序号后按分隔符拆分
        const cleaned = cleanPart(work);
        const parts = cleaned
            .split(/\s*[-—–_|:：]\s*/)
            .map((s) => s.trim())
            .filter(Boolean);

        if (parts.length >= 2) {
            // 视频命名惯例 “歌名 - 歌手”：取最后一个像人名的片段作歌手，
            // 其余片段拼回歌名（避免把更短的歌名误判成歌手）
            let artistIdx = -1;
            for (let i = parts.length - 1; i >= 0; i--) {
                if (plausibleArtist(parts[i])) {
                    artistIdx = i;
                    break;
                }
            }
            if (artistIdx !== -1) {
                artist = parts[artistIdx];
                title = parts.filter((_, i) => i !== artistIdx).join(' ');
            }
        }
        if (!title) title = cleaned;
    }

    // 清洗歌名中的噪声词与多余空白
    let cleanedTitle = title;
    for (const word of NOISE_WORDS) {
        cleanedTitle = cleanedTitle.replaceAll(word, ' ');
    }
    cleanedTitle = cleanedTitle.replace(/[\s\-_/·.]+/g, ' ').trim();
    if (cleanedTitle) title = cleanedTitle;

    // 歌手：标题中提取不到时，用原始 artist（排除频道名）
    if (!artist && rawArtist && !CHANNEL_NAME_RE.test(String(rawArtist))) {
        artist = String(rawArtist).trim();
    }

    return { title, artist };
}

/** bigram Dice 相似度，对中文短句和英文词序列都适用 */
function diceCoefficient(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const bigrams = (s: string) => {
        const map = new Map<string, number>();
        for (let i = 0; i < s.length - 1; i++) {
            const k = s.slice(i, i + 2);
            map.set(k, (map.get(k) ?? 0) + 1);
        }
        return map;
    };
    const ma = bigrams(a);
    const mb = bigrams(b);
    let overlap = 0;
    for (const [k, va] of ma) {
        const vb = mb.get(k);
        if (vb) overlap += Math.min(va, vb);
    }
    return (2 * overlap) / (a.length + b.length - 2);
}

/** 标题相似度 0~1：相等 > 包含 > bigram 相似 */
function titleSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const shorter = a.length <= b.length ? a : b;
    const longer = shorter === a ? b : a;
    // 短标题包含匹配需至少 2 个中文字符或 4 个拉丁字符，避免单字误配
    const minCjk = (shorter.match(/[一-龥]/g) ?? []).length;
    if (
        longer.includes(shorter) &&
        (minCjk >= 2 || shorter.replace(/[^a-z0-9]/g, '').length >= 4)
    ) {
        return 0.9;
    }
    return diceCoefficient(a, b);
}

/**
 * 为歌词候选打分：标题相似度为主（满分 100），歌手匹配加分。
 */
function scoreLyricCandidate(candidate: IMusic.IMusicItem, title: string, artist: string): number {
    const t = normalizeText(candidate.title);
    const qt = normalizeText(title);
    if (!t || !qt) return -1;

    const score = titleSimilarity(qt, t) * 100;
    if (score < 40) return -1;

    const qa = normalizeText(artist);
    const a = normalizeText(candidate.artist);
    if (qa && a) {
        if (a === qa) return score + 30;
        if (a.includes(qa) || qa.includes(a)) return score + 15;
        return score + diceCoefficient(qa, a) * 10;
    }
    return score;
}

class LyricManager {
    private parser: LyricParser | null = null;
    private currentMusicKey: string | null = null;
    /** 当前歌曲的 platform + musicId，用于写入 mediaMeta */
    private currentPlatform: string | null = null;
    private currentMusicId: string | null = null;
    /** 用户调整的歌词偏移（秒），正值表示歌词提前，负值表示歌词延后 */
    private userOffset = 0;
    /** 防抖写入 mediaMeta 的定时器 */
    private persistTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    /** 本会话已尝试过自动搜索歌词的歌曲，避免重复请求 */
    private autoSearchTried = new Set<string>();

    /** 获取并解析歌词 */
    async fetchLyric(musicItem: IMusic.IMusicItem): Promise<void> {
        const key = compositeKey(musicItem.platform, musicItem.id);
        this.currentMusicKey = key;
        this.currentPlatform = musicItem.platform;
        this.currentMusicId = String(musicItem.id);

        // 从 mediaMeta 恢复该歌曲的歌词偏移和关联歌词信息
        const meta = await mediaMeta.getMeta(musicItem.platform, String(musicItem.id));
        this.userOffset = meta?.lyricOffset ?? 0;
        store.set(associatedLyricAtom, meta?.associatedLyric?.musicItem ?? null);

        // 关联存在但缓存为空白时视为无效关联（历史脏数据），允许重新自动匹配
        const associatedRaw = meta?.associatedLyric?.rawLrc;
        const hasValidAssociated =
            !!meta?.associatedLyric &&
            (!!associatedRaw?.trim() || !!meta.associatedLyric.musicItem);

        try {
            const lyricSource = await pluginManager.adapters.getLyric(musicItem);

            // 切歌了，丢弃旧结果
            if (this.currentMusicKey !== key) return;

            if (!lyricSource?.rawLrc?.trim() && !lyricSource?.lrc?.trim()) {
                this.parser = null;
                store.set(currentLyricAtom, null);
                // 无有效歌词且未手动跳过自动搜索时，后台自动搜索其他音源
                if (!hasValidAssociated && !meta?.associatedLyricSkipped) {
                    void this.tryAutoSearchLyric(musicItem, key);
                }
                return;
            }

            this.applyLyric(
                lyricSource.rawLrc ?? lyricSource.lrc ?? '',
                lyricSource.translation,
                musicItem,
            );
        } catch {
            if (this.currentMusicKey === key) {
                this.parser = null;
                store.set(currentLyricAtom, null);
                if (!hasValidAssociated && !meta?.associatedLyricSkipped) {
                    void this.tryAutoSearchLyric(musicItem, key);
                }
            }
        }
    }

    /** 根据播放进度更新当前歌词行 */
    updatePosition(currentTime: number): void {
        if (!this.parser) return;

        const lyricItem = this.parser.getPosition(currentTime + this.userOffset);
        const prev = store.get(currentLyricAtom);

        if (prev?.currentLrc?.index !== lyricItem?.index) {
            store.set(currentLyricAtom, {
                parser: this.parser,
                currentLrc: lyricItem ?? undefined,
            });
        }
    }

    /** 重置 */
    reset(): void {
        this.parser = null;
        this.currentMusicKey = null;
        this.currentPlatform = null;
        this.currentMusicId = null;
        this.userOffset = 0;
        clearTimeout(this.persistTimer);
        store.set(currentLyricAtom, null);
        store.set(associatedLyricAtom, null);
    }

    /** 获取当前用户歌词偏移（秒） */
    getUserOffset(): number {
        return this.userOffset;
    }

    /** 设置用户歌词偏移（秒），并立即刷新当前歌词行 */
    setUserOffset(offset: number): void {
        this.userOffset = offset;
        const currentTime = store.get(progressAtom).currentTime;
        this.updatePosition(currentTime);

        // 防抖写入 mediaMeta
        clearTimeout(this.persistTimer);
        const platform = this.currentPlatform;
        const musicId = this.currentMusicId;
        if (platform && musicId) {
            this.persistTimer = setTimeout(() => {
                // 确保写入时仍是同一首歌
                if (this.currentPlatform !== platform || this.currentMusicId !== musicId) return;
                if (offset === 0) {
                    mediaMeta.setMeta(platform, musicId, { lyricOffset: null });
                } else {
                    mediaMeta.setMeta(platform, musicId, { lyricOffset: offset });
                }
            }, OFFSET_PERSIST_DELAY);
        }
    }

    /** 强制重新加载当前歌曲歌词（用于关联/取消关联歌词后刷新） */
    async refreshLyric(musicItem: IMusic.IMusicItem): Promise<void> {
        // 清除当前歌词状态，让 fetchLyric 重新加载
        this.parser = null;
        this.currentMusicKey = null;
        store.set(currentLyricAtom, null);
        await this.fetchLyric(musicItem);
    }

    /** 用歌词文本构建解析器并写入 atom（初始定位到当前播放时间） */
    private applyLyric(
        rawLrc: string,
        translation: string | undefined,
        musicItem: IMusic.IMusicItem,
    ): void {
        this.parser = new LyricParser(rawLrc, {
            musicItem,
            translation,
        });

        // C-17: 初始定位到当前播放时间（恢复播放等场景，避免歌词从头开始）
        const currentTime = store.get(progressAtom).currentTime;
        store.set(currentLyricAtom, {
            parser: this.parser,
            currentLrc: this.parser.getPosition(currentTime + this.userOffset) ?? undefined,
        });
    }

    /**
     * 当前歌曲无歌词时，自动在所有支持歌词搜索的插件中查找同名歌曲：
     * 并发搜索 → 标题/歌手匹配打分 → 取最佳候选的歌词 → 写入关联并即时替换。
     * 关联成功后写入 mediaMeta.associatedLyric，以后播放直接命中缓存。
     */
    private async tryAutoSearchLyric(musicItem: IMusic.IMusicItem, key: string): Promise<void> {
        if (appConfig.getConfigByKey('lyric.autoSearchMissing') === false) return;
        if (this.autoSearchTried.has(key)) return;
        this.autoSearchTried.add(key);

        // 从带噪声的视频/合集标题中提取真实歌名与歌手
        const { title, artist } = extractSongMeta(musicItem.title, musicItem.artist);
        if (!title) return;

        const cleanQuery = [title, artist].filter(Boolean).join(' ');
        const originalQuery = [musicItem.title, musicItem.artist]
            .filter((s) => String(s ?? '').trim())
            .join(' ');

        // 所有“可搜索且能取歌词”的插件（不限于声明 lyric 搜索类型的插件），排除本地插件
        const plugins = pluginManager
            .getSupportedPlugin('search')
            .filter(
                (p) => p.platform !== LOCAL_PLUGIN_NAME && p.supportedMethod?.includes('getLyric'),
            );
        if (plugins.length === 0) return;

        const runSearch = async (
            query: string,
            searchType: IMedia.SupportMediaType,
        ): Promise<Array<{ item: IMusic.IMusicItem; score: number }>> => {
            const results = await Promise.allSettled(
                plugins.map((plugin) =>
                    pluginManager.callPluginMethod({
                        hash: plugin.hash,
                        method: 'search',
                        args: [query, 1, searchType],
                    }),
                ),
            );
            const found: Array<{ item: IMusic.IMusicItem; score: number }> = [];
            results.forEach((result) => {
                if (result.status !== 'fulfilled') return;
                const items = (result.value?.data ?? []) as IMusic.IMusicItem[];
                for (const item of items.slice(0, AUTO_SEARCH_CANDIDATE_LIMIT)) {
                    const score = scoreLyricCandidate(item, title, artist);
                    if (score >= AUTO_SEARCH_MIN_SCORE) found.push({ item, score });
                }
            });
            return found;
        };

        // 先用清洗后的歌名搜索：同时尝试 lyric 与 music 两种搜索类型
        // （多数音源插件只声明 music 类型，但歌曲项同样可用于 getLyric）
        let candidates = [
            ...(await runSearch(cleanQuery, 'lyric')),
            ...(await runSearch(cleanQuery, 'music')),
        ];
        // 无候选时回退用原始标题再试一次
        if (candidates.length === 0 && originalQuery !== cleanQuery) {
            candidates = [
                ...(await runSearch(originalQuery, 'lyric')),
                ...(await runSearch(originalQuery, 'music')),
            ];
        }
        if (candidates.length === 0) return;

        // 去重（同平台同 id），按匹配分从高到低取前若干个依次尝试取歌词
        const seen = new Set<string>();
        candidates = candidates
            .filter(({ item }) => {
                const dedupeKey = `${item.platform}\u0000${item.id}`;
                if (seen.has(dedupeKey)) return false;
                seen.add(dedupeKey);
                return true;
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, AUTO_SEARCH_MAX_CANDIDATES);
        for (const { item } of candidates) {
            if (this.currentMusicKey !== key) return; // 已切歌

            let lyricSource: ILyric.ILyricSource | null = null;
            try {
                lyricSource = await pluginManager.callPluginMethod({
                    platform: item.platform,
                    method: 'getLyric',
                    args: [item],
                });
            } catch {
                continue;
            }

            if (this.currentMusicKey !== key) return;
            // 拒绝空歌词/纯空白歌词，继续尝试下一个候选
            if (!lyricSource?.rawLrc?.trim() && !lyricSource?.translation?.trim()) {
                continue;
            }

            const rawLrc = (lyricSource.rawLrc ?? lyricSource.translation ?? '').trim();
            const translation = lyricSource.rawLrc?.trim() ? lyricSource.translation : undefined;

            // 写入关联（含文本缓存），与手动「关联歌词」结构一致
            await mediaMeta
                .setMeta(musicItem.platform, String(musicItem.id), {
                    associatedLyric: {
                        musicItem: item,
                        rawLrc,
                        translation,
                    },
                    associatedLyricSkipped: null,
                })
                .catch(() => {});

            if (this.currentMusicKey !== key) return;
            store.set(associatedLyricAtom, item);
            this.applyLyric(rawLrc, translation, musicItem);
            return;
        }
    }
}

export default LyricManager;
