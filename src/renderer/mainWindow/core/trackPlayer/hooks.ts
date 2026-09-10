/**
 * TrackPlayer — React Hooks
 */
import { useAtomValue } from 'jotai/react';
import {
    currentMusicAtom,
    musicQueueAtom,
    playerStateAtom,
    repeatModeAtom,
    progressAtom,
    volumeAtom,
    speedAtom,
    qualityAtom,
    currentLyricAtom,
    associatedLyricAtom,
    displayPlatformAtom,
} from './store';
import { getDisplayPlatform } from './displaySource';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';

export const useCurrentMusic = () => useAtomValue(currentMusicAtom);
export const useProgress = () => useAtomValue(progressAtom);
export const usePlayerState = () => useAtomValue(playerStateAtom);
export const useRepeatMode = () => useAtomValue(repeatModeAtom);
export const useMusicQueue = () => useAtomValue(musicQueueAtom);
export const useLyric = () => useAtomValue(currentLyricAtom);
export const useVolume = () => useAtomValue(volumeAtom);
export const useSpeed = () => useAtomValue(speedAtom);
export const useQuality = () => useAtomValue(qualityAtom);
export const useAssociatedLyric = () => useAtomValue(associatedLyricAtom);

/** 换源后各列表的“来源”标签需要响应式刷新时使用 */
export const useDisplayPlatformMap = () => useAtomValue(displayPlatformAtom);

/** 单首歌的展示来源（换源后为关联音源平台，否则为原平台） */
export function useDisplayPlatform(item?: IMusicItemSlim | null): string | undefined {
    useAtomValue(displayPlatformAtom);
    return getDisplayPlatform(item);
}
