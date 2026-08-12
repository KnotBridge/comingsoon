// Stub. The real-estate "dynamic page" feature was removed in this build, so
// there are no per-campaign dynamic-page view stats. Kept as a no-op so the
// Sent Log page compiles and renders without that column.
export interface DynamicPageStats {
  views: number;
  signups: number;
  firstViewedAt: string | null;
}

export function useDynamicPageStats(_campaignId?: string | null): {
  stats: Record<string, DynamicPageStats>;
  loading: boolean;
} {
  return { stats: {}, loading: false };
}
