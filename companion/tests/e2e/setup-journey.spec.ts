import { expect, test } from "@playwright/test";

test("signs in, chooses playlists, and creates a desktop export", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).syncandrunDesktop = {
      platform: "linux",
      chooseFolder: async () => "/tmp/syncandrun-e2e-output",
      exportMusic: async (options: unknown) => {
        (window as any).__exportOptions = options;
        return { path: "/tmp/syncandrun-e2e-output/SyncAndRun-fixture", completed: 2, route: "mtp" };
      },
      showFolder: async (path: string) => { (window as any).__openedPath = path; },
      onProgress: () => () => undefined
    };
  });
  await page.goto("/");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign in with Plex" }).click();
  const popup = await popupPromise;
  await expect(popup.getByText("SyncAndRun fixture authorization complete.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your music" })).toBeVisible();
  await expect(page.getByText("This playlist exceeds the 10,000-track safety limit and cannot be added.")).toBeVisible();
  await page.getByLabel("Fixture Favorites").check();
  await page.getByLabel("MP3 quality").selectOption("320");
  await page.getByRole("button", { name: "Choose a folder" }).click();
  await page.getByRole("button", { name: "Create music folder" }).click();
  await expect(page.getByText("Files ready")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__exportOptions)).toEqual({
    playlistIds: ["plex:playlist:10"], bitrate: 320, route: "mtp"
  });
  await page.getByRole("button", { name: "Open folder" }).click();
  expect(await page.evaluate(() => (window as any).__openedPath)).toContain("SyncAndRun-fixture");
});

test("retired watch endpoints are unavailable", async ({ request }) => {
  expect((await request.get("/api/v1/watch/config")).status()).toBe(404);
  expect((await request.get("/api/v1/devices")).status()).toBe(404);
});
