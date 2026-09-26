import { expect, test } from "@playwright/test";

test("completes setup, playlist selection, pairing, naming, live status, and deletion", async ({ page }) => {
  // A fresh installation needs no setup link: the first Plex account claims it.
  await page.goto("/");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign in with Plex" }).click();
  const popup = await popupPromise;
  await expect(popup.getByText("SyncAndRun fixture authorization complete.")).toBeVisible();

  // One reachable server with one music library: no questions. The fixture's
  // LAN connection is unreachable, so this also proves the fallback to the
  // next connection.

  await expect(page.getByRole("heading", { name: "Plex playlists" })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 720 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true);
  await expect(page.getByRole("button", { name: "Refresh from Plex" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByLabel("Fixture Shared")).toBeDisabled();
  await expect(page.getByText("This playlist exceeds the 10,000-track safety limit and cannot be added.")).toBeVisible();
  await page.getByLabel("Fixture Favorites").check();
  await page.getByLabel("Fixture Favorites").uncheck();
  await page.getByLabel("Fixture Favorites").check();
  await expect(page.getByRole("button", { name: "Save playlist selection" })).toHaveCount(0);
  await expect(page.getByText("Saved. Pending the next watch sync.")).toBeVisible();
  await expect(page.locator(".worklist-status").getByText("Pending sync")).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  // The settings console mixes state it only reports with state it can change,
  // and the watch address is the one value the operator must retype elsewhere.
  await expect(page.getByText("http://127.0.0.1:34117")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(page.getByText("Read-only").first()).toBeVisible();
  await expect(page.getByText("Editable")).toBeVisible();
  await page.getByLabel("MP3 quality").selectOption("high");
  await page.getByRole("button", { name: "Save audio quality" }).click();
  await expect(page.getByText("Audio quality saved.")).toBeAttached();

  await page.getByRole("button", { name: "Watch", exact: true }).click();
  // With no watch paired, the page opens on a ready code and the exact address.
  await expect(page.getByRole("heading", { name: "Pair your watch" })).toBeVisible();
  await expect(page.locator(".watch-steps").getByText("127.0.0.1:34117")).toBeVisible();
  await expect(page.locator(".watch-steps").getByText("127.000.000.001")).toBeVisible();
  const code = (await page.locator(".pairing-code").innerText()).trim();
  expect(code).toMatch(/^[0-9]{6}$/);
  const deviceToken = await page.evaluate(async (pairingCode) => {
    const response = await fetch("/api/v1/watch/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: pairingCode,
        deviceId: "watch:playwright",
        deviceName: "Forerunner 955 Solar",
        appVersion: "1.0.0",
        protocolVersion: 1
      })
    });
    if (!response.ok) throw new Error(`Fixture watch pairing failed: ${response.status}`);
    return ((await response.json()) as { deviceToken: string }).deviceToken;
  }, code);
  await page.getByRole("button", { name: "Playlists", exact: true }).click();
  await page.getByRole("button", { name: "Watch", exact: true }).click();
  await expect(page.getByText("Forerunner 955 Solar").first()).toBeVisible();

  // The pre-sync estimate is available before the watch has ever transferred.
  await expect(page.getByText("default Forerunner estimate").first()).toBeVisible();

  // The card must not resize as sync state changes, and the track name must
  // survive the gap between transfers, when the watch reports no current track.
  const cardHeight = async () =>
    page.evaluate(() => Math.round(document.querySelector(".device-card")!.getBoundingClientRect().height));
  const idleHeight = await cardHeight();

  await page.evaluate(async (token) => {
    const auth = { Authorization: `Bearer ${token}` };
    await fetch("/api/v1/watch/playlists", { headers: auth });
    const audio = await fetch("/api/v1/watch/tracks/plex%3Atrack%3A100/audio", { headers: auth });
    if (!audio.ok) throw new Error(`Fixture audio transfer failed: ${audio.status}`);
    await audio.text();
  }, deviceToken);

  await expect(page.getByText("Fixture One", { exact: false }).first()).toBeVisible();
  expect(await cardHeight()).toBe(idleHeight);

  await page.evaluate(async (token) => {
    const config = await (await fetch("/api/v1/watch/config", { headers: { Authorization: `Bearer ${token}` } })).json();
    await fetch("/api/v1/watch/sync-result", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        protocolVersion: 1,
        revision: (config as { manifestRevision: string }).manifestRevision,
        status: "applied",
        counts: { downloaded: 2, reused: 0, deleted: 0, failed: 0 },
        errorCodes: []
      })
    });
  }, deviceToken);

  await expect(page.getByText("Sync applied", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Playlists", exact: true }).click();
  await expect(page.locator(".worklist-status").getByText("Synced")).toBeVisible();
  await page.getByRole("button", { name: "Watch", exact: true }).click();
  // The finished card still names the last track it transferred.
  await expect(page.getByText("Fixture One", { exact: false }).first()).toBeVisible();
  expect(await cardHeight()).toBe(idleHeight);

  // Phone layout: a row's controls share one scale and nothing escapes the
  // panel, including the armed confirmation and the diagnostics table.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "Remove watch" }).click();
  const rowMetrics = await page.evaluate(() => {
    const row = document.querySelector(".worklist-row")!;
    const panel = row.closest(".panel")!.getBoundingClientRect();
    return {
      buttonHeights: [...row.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().height)),
      tagHeights: [...row.querySelectorAll(".tag")].map((t) => Math.round(t.getBoundingClientRect().height)),
      escaping: [...row.querySelectorAll("*")].filter(
        (e) => !e.closest(".table-scroll") && e.getBoundingClientRect().right > panel.right + 1
      ).length
    };
  });
  expect(new Set(rowMetrics.buttonHeights).size).toBe(1);
  // A freshly paired watch may carry no status chip; any it does carry share one height.
  expect(new Set(rowMetrics.tagHeights).size).toBeLessThanOrEqual(1);
  expect(rowMetrics.escaping).toBe(0);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Watch name").fill("Trail watch");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Trail watch").first()).toBeVisible();
  await expect(page.getByText("reported as Forerunner 955 Solar")).toBeVisible();

  await page.getByRole("button", { name: "Remove watch" }).click();
  await page.getByRole("button", { name: "Confirm removal" }).click();
  await expect(page.getByText("Removed watches")).toBeVisible();
  await page.getByRole("button", { name: "Delete record" }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page.getByRole("heading", { name: "Pair your watch" })).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Delete all local data" }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page.getByRole("button", { name: "Sign in with Plex" })).toBeVisible();
});

test("shows a failed automatic playlist save and retries it", async ({ page }) => {
  await page.goto("/");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign in with Plex" }).click();
  const popup = await popupPromise;
  await expect(popup.getByText("SyncAndRun fixture authorization complete.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plex playlists" })).toBeVisible();

  let attempts = 0;
  await page.route("**/api/v1/playlists/selection", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({
        error: { message: "Fixture save failed." }
      }) });
    } else {
      await route.continue();
    }
  });

  await page.getByLabel("Fixture Favorites").check();
  await expect(page.getByText("Fixture save failed.")).toBeVisible();
  await expect(page.locator(".worklist-status").getByText("Not saved")).toBeVisible();
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByText("Saved. Pending the next watch sync.")).toBeVisible();
  expect(attempts).toBe(2);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Delete all local data" }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page.getByRole("button", { name: "Sign in with Plex" })).toBeVisible();
});

test("saves the final checkbox state after a change during an in-flight save", async ({ page }) => {
  await page.goto("/");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign in with Plex" }).click();
  const popup = await popupPromise;
  await expect(popup.getByText("SyncAndRun fixture authorization complete.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plex playlists" })).toBeVisible();

  let startFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { startFirst = resolve; });
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let attempts = 0;
  await page.route("**/api/v1/playlists/selection", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      startFirst();
      await firstRelease;
    }
    await route.continue();
  });

  await page.getByLabel("Fixture Favorites").check();
  await firstStarted;
  await page.getByLabel("Fixture Favorites").uncheck();
  releaseFirst();
  await expect.poll(async () => page.evaluate(async () => {
    const result = await (await fetch("/api/v1/playlists")).json() as { playlists: Array<{ selected: boolean }> };
    return result.playlists.some((playlist) => playlist.selected);
  })).toBe(false);
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByText("Select playlists to save them automatically.")).toBeVisible();
});

test("switches between the console and printout themes and remembers the choice", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Light printout" }).click();
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.getByRole("button", { name: "Dark console" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
});
