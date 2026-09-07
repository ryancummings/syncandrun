import { expect, test } from "@playwright/test";

test("completes setup, playlist selection, pairing, naming, live status, and deletion", async ({ page, request }) => {
  const invitation = await request.get("/__test/setup-link");
  await page.goto((await invitation.json()).path);
  await expect(page).toHaveURL(/\/$/);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect Plex" }).click();
  const popup = await popupPromise;
  await expect(popup.getByText("SyncAndRun fixture authorization complete.")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Choose a Plex server" })).toBeVisible();
  await page.getByRole("button", { name: "Continue to music library" }).click();
  await expect(page.getByRole("heading", { name: "Choose a music library" })).toBeVisible();
  await expect(page.getByLabel("Plex music library")).toHaveValue("2");
  await page.getByRole("button", { name: "Finish setup" }).click();

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
  await page.getByRole("button", { name: "Save playlist selection" }).click();
  await expect(page.getByText("Playlist selection saved.")).toBeAttached();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  // The settings console mixes state it only reports with state it can change,
  // and the watch address is the one value the operator must retype elsewhere.
  await expect(page.getByText("https://music.example.test/")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(page.getByText("Read-only").first()).toBeVisible();
  await expect(page.getByText("Editable")).toBeVisible();
  await page.getByLabel("MP3 quality").selectOption("high");
  await page.getByRole("button", { name: "Save audio quality" }).click();
  await expect(page.getByText("Audio quality saved.")).toBeAttached();

  await page.getByRole("button", { name: "Watch", exact: true }).click();
  await page.getByRole("button", { name: "Create pairing code" }).click();
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
  await expect(page.getByText("No watches are paired yet.")).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Delete all local data" }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page.getByRole("button", { name: "Connect Plex" })).toBeVisible();
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
