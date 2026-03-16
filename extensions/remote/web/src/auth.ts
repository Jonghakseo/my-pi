export type RemoteMode = "lan" | "tailscale" | "funnel";

export interface RemoteInfo {
  url: string;
  mode: RemoteMode;
  hasTailscale: boolean;
  reason?: string;
  pinMayRotate: boolean;
  pinLength?: number;
}

let cachedInfoPromise: Promise<RemoteInfo> | null = null;

function getInfoUrl(): string {
  const token = new URLSearchParams(window.location.search).get("token");
  if (!token) return "/api/info";
  return `/api/info?token=${encodeURIComponent(token)}`;
}

export async function getRemoteInfo(): Promise<RemoteInfo> {
  cachedInfoPromise ??= fetch(getInfoUrl()).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Failed to load remote info (${response.status})`);
    }
    return (await response.json()) as RemoteInfo;
  });

  return cachedInfoPromise;
}

export async function isLanMode(): Promise<boolean> {
  const info = await getRemoteInfo();
  return info.mode === "lan";
}

export async function showAuthScreen(
  container: HTMLElement,
  onAuth: (token: string) => void,
): Promise<RemoteInfo> {
  const info = await getRemoteInfo();
  if (info.mode === "lan") {
    container.replaceChildren();
    return info;
  }

  const pinLength = info.pinLength ?? (info.mode === "funnel" ? 8 : 6);
  const wrapper = document.createElement("div");
  wrapper.id = "auth-screen";
  wrapper.innerHTML = `
    <div class="auth-card">
      <h2>${info.mode === "funnel" ? "Public remote access" : "Secure remote access"}</h2>
      <p>Enter the ${pinLength}-digit PIN shown in pi to continue.</p>
      <form id="auth-form" autocomplete="one-time-code">
        <input id="auth-pin" inputmode="numeric" pattern="[0-9]*" maxlength="${pinLength}" placeholder="${"•".repeat(pinLength)}" />
        <button type="submit">Continue</button>
      </form>
      <div id="auth-error" aria-live="polite"></div>
      <div class="auth-meta">
        ${info.reason ? `<div>${escapeHtml(info.reason)}</div>` : ""}
        ${info.pinMayRotate ? "<div>PIN may rotate automatically after expiry or repeated failures.</div>" : ""}
      </div>
    </div>
  `;

  container.replaceChildren(wrapper);

  const form = wrapper.querySelector<HTMLFormElement>("#auth-form");
  const input = wrapper.querySelector<HTMLInputElement>("#auth-pin");
  const error = wrapper.querySelector<HTMLElement>("#auth-error");
  if (!form || !input || !error) {
    throw new Error("Auth UI failed to initialise");
  }

  input.focus();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const pin = input.value.replace(/\D/g, "").slice(0, pinLength);
    input.value = pin;

    if (pin.length !== pinLength) {
      error.textContent = `${pinLength} digits are required.`;
      return;
    }

    error.textContent = "Checking…";

    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const payload = (await response.json().catch(() => ({}))) as { token?: string; error?: string };

      if (!response.ok || !payload.token) {
        error.textContent = payload.error ?? "Authentication failed.";
        return;
      }

      sessionStorage.setItem("piRemoteJwt", payload.token);
      error.textContent = "";
      container.replaceChildren();
      onAuth(payload.token);
    } catch (requestError) {
      error.textContent = requestError instanceof Error ? requestError.message : "Authentication failed.";
    }
  });

  return info;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
