import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { getMachineId } from "./cosy.js";
import { interactiveLogin } from "./login.js";
import { updateQoderModelsCache } from "./models.js";

export interface QoderCredentials extends OAuthCredentials {
  userID: string;
  email: string;
  name: string;
  machineID: string;
}

const CREDENTIALS_CACHE_FILE = join(homedir(), ".pi", "agent", "qoder-credentials-cache.json");

export function saveCachedCredentials(creds: QoderCredentials) {
  try {
    mkdirSync(dirname(CREDENTIALS_CACHE_FILE), { recursive: true });
    writeFileSync(CREDENTIALS_CACHE_FILE, JSON.stringify(creds, null, 2), "utf-8");
  } catch {}
}

export function getCachedCredentials(accessToken: string): QoderCredentials | null {
  if (existsSync(CREDENTIALS_CACHE_FILE)) {
    try {
      const creds = JSON.parse(readFileSync(CREDENTIALS_CACHE_FILE, "utf-8"));
      if (creds && creds.access === accessToken) {
        return creds as QoderCredentials;
      }
    } catch {}
  }
  return null;
}

export async function loginQoder(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  // 1. Try environment variables first (PAT)
  const pat = process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_PAT;
  if (pat) {
    try {
      const userinfoRes = await fetch("https://openapi.qoder.sh/api/v1/userinfo", {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/json",
          "User-Agent": "pi-provider-qoder",
        },
      });
      if (userinfoRes.ok) {
        const userinfo = (await userinfoRes.json()) as {
          id?: string;
          email?: string;
          name?: string;
          username?: string;
        };
        const email = userinfo.email || "";
        const name = userinfo.name || userinfo.username || "";
        const userID = userinfo.id || "pat";
        const machineID = getMachineId();

        const creds = {
          refresh: `pat|${userID}|${machineID}`,
          access: pat,
          expires: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
          userID,
          email,
          name,
          machineID,
        };

        saveCachedCredentials(creds);
        // Cache models in background
        updateQoderModelsCache(pat, userID, name, email).catch(() => {});

        return creds;
      }
    } catch {}
  }

  // 2. Interactive login
  const creds = await interactiveLogin(callbacks);

  // Cache models in background and save credentials
  try {
    const qCreds = creds as QoderCredentials;
    saveCachedCredentials(qCreds);
    updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email).catch(() => {});
  } catch {}

  return creds;
}

export async function refreshQoderToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] || "";
  const userID = parts[1] || "";
  const machineID = parts[2] || getMachineId();

  if (refreshToken === "pat") {
    // PAT tokens don't need refreshing, just extend validity
    return {
      ...credentials,
      expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
    };
  }

  const refreshURL = "https://center.qoder.sh/algo/api/v3/user/refresh_token";
  try {
    const response = await fetch(refreshURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.access}`,
        Accept: "application/json",
        "User-Agent": "pi-provider-qoder",
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        token: string;
        refresh_token?: string;
        expires_at?: string;
        expires_in?: number;
      };

      const newAccess = data.token;
      const newRefresh = data.refresh_token || refreshToken;

      let expireMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
      if (data.expires_at) {
        const parsed = Date.parse(data.expires_at);
        if (!Number.isNaN(parsed)) expireMs = parsed;
      } else if (data.expires_in) {
        expireMs = Date.now() + data.expires_in * 1000;
      }

      const refreshed = {
        ...credentials,
        refresh: `${newRefresh}|${userID}|${machineID}`,
        access: newAccess,
        expires: expireMs - 5 * 60 * 1000,
        userID,
        email: (credentials as any).email || "",
        name: (credentials as any).name || "",
        machineID,
      };

      saveCachedCredentials(refreshed as QoderCredentials);
      // Cache models in background
      updateQoderModelsCache(
        newAccess,
        userID,
        (credentials as any).name || "",
        (credentials as any).email || "",
      ).catch(() => {});

      return refreshed;
    }
  } catch {}

  // Fallback: Extend validity slightly to buy time, as Qoder tokens are long-lived
  const refreshedFallback = {
    ...credentials,
    expires: Date.now() + 60 * 60 * 1000, // extend for 1 hour
  };
  try {
    saveCachedCredentials(refreshedFallback as QoderCredentials);
  } catch {}
  return refreshedFallback;
}
