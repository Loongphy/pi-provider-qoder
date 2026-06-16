import type { OAuthCredentials } from "@earendil-works/pi-ai";

interface QoderQuota {
  total: number;
  used: number;
  remaining: number;
  percentage: number;
  unit: string;
}

interface QoderUsageInfo {
  userQuota: QoderQuota;
  orgResourcePackage: QoderQuota;
  totalUsagePercentage: number;
  isQuotaExceeded: boolean;
  expiresAt: number;
}

export interface QoderProviderUsage {
  summary?: string;
  subscriptionTitle?: string;
  resetAt?: string;
  manageUrl?: string;
  usageBuckets?: Array<{
    id: string;
    label: string;
    usedDisplay: string;
    limitDisplay?: string;
    unit?: string;
    resetAt?: string;
  }>;
  raw?: Record<string, unknown>;
}

export async function fetchQoderUsage(credentials: OAuthCredentials): Promise<QoderProviderUsage> {
  const usageURL = "https://openapi.qoder.sh/api/v2/quota/usage";
  const response = await fetch(usageURL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${credentials.access}`,
      Accept: "application/json",
      "User-Agent": "pi-provider-qoder",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Qoder usage: ${response.status} ${response.statusText}`);
  }

  const raw = (await response.json()) as QoderUsageInfo;
  const usageBuckets = [];

  if (raw.userQuota) {
    usageBuckets.push({
      id: "user-quota",
      label: "User Quota",
      usedDisplay: raw.userQuota.used.toFixed(2),
      limitDisplay: raw.userQuota.total.toFixed(2),
      unit: raw.userQuota.unit,
      resetAt: raw.expiresAt ? new Date(raw.expiresAt).toISOString() : undefined,
    });
  }

  if (raw.orgResourcePackage && raw.orgResourcePackage.total > 0) {
    usageBuckets.push({
      id: "org-resource-package",
      label: "Org Resource Package",
      usedDisplay: raw.orgResourcePackage.used.toFixed(2),
      limitDisplay: raw.orgResourcePackage.total.toFixed(2),
      unit: raw.orgResourcePackage.unit,
      resetAt: raw.expiresAt ? new Date(raw.expiresAt).toISOString() : undefined,
    });
  }

  const remainingText = raw.userQuota ? `${raw.userQuota.remaining.toFixed(2)} ${raw.userQuota.unit} remaining` : "";

  return {
    summary: remainingText,
    subscriptionTitle: "Qoder AI Plan",
    resetAt: raw.expiresAt ? new Date(raw.expiresAt).toISOString() : undefined,
    manageUrl: "https://qoder.com",
    usageBuckets,
    raw: raw as unknown as Record<string, unknown>,
  };
}
