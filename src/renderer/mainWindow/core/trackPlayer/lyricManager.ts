/**
 * LyricManager — 歌词获取 & 逐行追踪
 *
 * 通过 pluginManager 获取歌词源，使用 LyricParser 解析，
 * 播放进度变化时更新当前歌词行并写入 jotai atom。
 */
import LyricParser from '@common/lyricParser';
import { compositeKey } from '@common/mediaKey';
import pluginManager from '@infra/pluginManager/renderer';
import mediaMeta from '@infra/mediaMeta/renderer';
import appConfig from '@infra/appConfig/renderer';
import { store, currentLyricAtom, progressAtom, associatedLyricAtom } from './store';

/** 歌词偏移写入 mediaMeta 的防抖延迟（ms） */
const OFFSET_PERSIST_DELAY = 500;

/** 自动搜索时每个插件取前 N 条候选做匹配 */
const AUTO_SEARCH_CANDIDATE_LIMIT = 3;
/** 自动关联的最低匹配分：标题需完全相等或互相包含 */
const AUTO_SEARCH_MIN_SCORE = 70;

/** 文本归一化：仅保留中文、字母与数字，用于标题/歌手匹配 */
function normalizeText(text: unknown): string {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
}

/**
 * 为歌词候选打分：标题完全相等 100，互相包含 70，
 * 歌手完全相等 +30，互相包含 +15。
 */
function scoreLyricCandidate(candidate: IMusic.IMusicItem, title: string, artist: string): number {
    const t = normalizeText(candidate.title);
    const qt = normalizeText(title);
    if (!t || !qt) return -1;

    let score = 0;
    if (t === qt) {
        score += 100;
    } else if (t.includes(qt) || qt.includes(t)) {
        score += 70;
    }

    const qa = normalizeText(artist);
    const a = normalizeText(candidate.artist);
    if (qa && a) {
        if (a === qa) score += 30;
        else if (a.includes(qa) || qa.includes(a)) score += 15;
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

        try {
            const lyricSource = await pluginManager.adapters.getLyric(musicItem);

            // 切歌了，丢弃旧结果
            if (this.currentMusicKey !== key) return;

            if (!lyricSource?.rawLrc && !lyricSource?.lrc) {
                this.parser = null;
                store.set(currentLyricAtom, null);
                // 无歌词且用户未手动关联/未跳过自动搜索时，后台自动搜索其他音源
                if (!meta?.associatedLyric && !meta?.associatedLyricSkipped) {
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
                if (!meta?.associatedLyric && !meta?.associatedLyricSkipped) {
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

        const title = musicItem.title ?? '';
        if (!title.trim()) return;
        const artist = musicItem.artist ?? '';
        const query = [title, artist].filter((s) => s?.trim()).join(' ');

        const plugins = pluginManager.getSearchablePlugins('lyric');
        if (plugins.length === 0) return;

        // 并发搜索全部插件，收集候选
        const searchResults = await Promise.allSettled(
            plugins.map((plugin) =>
                pluginManager.callPluginMethod({
                    hash: plugin.hash,
                    method: 'search',
                    args: [query, 1, 'lyric'],
                }),
            ),
        );

        const candidates: Array<{ item: IMusic.IMusicItem; score: number }> = [];
        searchResults.forEach((result) => {
            if (result.status !== 'fulfilled') return;
            const items = (result.value?.data ?? []) as IMusic.IMusicItem[];
            for (const item of items.slice(0, AUTO_SEARCH_CANDIDATE_LIMIT)) {
                const score = scoreLyricCandidate(item, title, artist);
                if (score >= AUTO_SEARCH_MIN_SCORE) {
                    candidates.push({ item, score });
                }
            }
        });
        if (candidates.length === 0) return;

        // 按匹配分从高到低，依次尝试取歌词，第一个成功者胜出
        candidates.sort((a, b) => b.score - a.score);
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
            if (!lyricSource?.rawLrc && !lyricSource?.translation) continue;

            const rawLrc = lyricSource.rawLrc ?? lyricSource.translation ?? '';
            const translation = lyricSource.rawLrc ? lyricSource.translation : undefined;

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
