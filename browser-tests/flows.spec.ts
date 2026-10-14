import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { sampleRawPayload } from "../src/__tests__/fixtures/samplePayload";

async function mockData(context: BrowserContext) {
  const payload = structuredClone(sampleRawPayload);
  payload.armor.forEach((piece) => {
    piece.skills = [];
  });
  payload.charms.forEach((charm) =>
    charm.ranks.forEach((rank) => {
      rank.skills = [];
    }),
  );
  await context.route("https://wilds.mhdb.io/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      path === "/version"
        ? { version: "browser-fixture" }
        : path.endsWith("/armor/sets")
          ? payload.armorSets
          : path.endsWith("/armor")
            ? payload.armor
            : path.endsWith("/skills")
              ? payload.skills
              : path.endsWith("/decorations")
                ? payload.decorations
                : path.endsWith("/charms")
                  ? payload.charms
                  : [];
    await route.fulfill({ json: body });
  });
}
async function ready(page: Page) {
  await page.goto("/");
  await expect(page.locator("#data-status")).toContainText("browser-fixture");
  await page
    .getByRole("searchbox", { name: "Search skills", exact: true })
    .fill("Constitution");
  await page
    .locator("#skill-options button")
    .filter({ hasText: "Constitution" })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Find builds", exact: true }),
  ).toBeEnabled();
}
async function search(page: Page) {
  await page.getByRole("button", { name: "Find builds", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Find builds", exact: true }),
  ).toBeEnabled();
}
test.beforeEach(async ({ context }) => {
  await mockData(context);
});

test("owned jewel quantities determine feasibility and changed settings invalidate results", async ({
  page,
}) => {
  await ready(page);
  await page.getByLabel("Use only quantities I own").check();
  await search(page);
  await expect(page.locator(".result-card")).toHaveCount(0);
  await page.getByLabel(/Owned copies of Constitution/).fill("1");
  await search(page);
  await expect(page.locator(".result-card").first()).toContainText(
    "Required skills met",
  );
  await page.getByLabel(/Owned copies of Constitution/).fill("0");
  await expect(page.locator(".result-card")).toHaveCount(0);
  await expect(page.locator("#run-status")).toContainText("Settings changed");
});

test("talisman editing preserves the original until saved and escapes imported names", async ({
  page,
}) => {
  await page.goto("/charm-builder/");
  await expect(page.locator(".skill-select option").first()).toBeAttached();
  await page.locator("#charm-name").fill("<img src=x onerror=alert(1)>");
  await page.locator("#weapon-slot").fill("2");
  await page.locator("#add-charm").click();
  await expect(page.locator(".owned-card")).toHaveCount(1);
  await expect(page.locator(".owned-card img")).toHaveCount(0);
  await expect(page.locator(".owned-card")).toContainText("weapon slot: 2");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("#charm-name").fill("Changed");
  await expect(page.locator(".owned-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Cancel edit", exact: true }).click();
  await expect(page.locator(".owned-card")).toContainText("<img");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("#charm-name").fill("Saved change");
  await page.locator("#add-charm").click();
  await expect(page.locator(".owned-card")).toHaveCount(1);
  await expect(page.locator(".owned-card")).toContainText("Saved change");
  await page
    .getByRole("button", { name: "Restore previous inventory", exact: true })
    .click();
  await expect(page.locator(".owned-card")).toContainText("<img");
});

test("exact build sharing restores the chosen equipment and mobile layout stays within the screen", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await search(page);
  const card = page.locator(".result-card").first();
  await expect(card).toContainText("Required skills met");
  const equipment = await card.locator("table").innerText();
  await card.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.locator("#comparison")).toContainText("Equipment defense");
  await card
    .getByRole("button", { name: "Share this build", exact: true })
    .click();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toContain("#");
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.locator(".result-card").first()).toBeVisible();
  expect(
    await other.locator(".result-card").first().locator("table").innerText(),
  ).toBe(equipment);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("one owned talisman is equipped and worker counts preserve the best result", async ({
  page,
  context,
}) => {
  await ready(page);
  const builder = await context.newPage();
  await builder.goto("/charm-builder/");
  await expect(builder.locator(".skill-select option").first()).toBeAttached();
  await builder.locator("#charm-name").fill("My Constitution talisman");
  await builder.locator(".skill-select").selectOption("1");
  await builder.locator("#add-charm").click();
  await expect(builder.locator(".owned-card")).toHaveCount(1);
  await page
    .getByRole("combobox", { name: "Build mode", exact: true })
    .selectOption("owned");
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await page.getByText("Search options", { exact: true }).click();
  await page.getByLabel("Search workers", { exact: true }).fill("1");
  await search(page);
  const first = await page
    .locator(".result-card")
    .first()
    .locator("table")
    .innerText();
  expect(first).toContain("My Constitution talisman");
  expect(first).not.toContain("Rush Charm");
  await page.getByLabel("Search workers", { exact: true }).fill("4");
  await search(page);
  expect(
    await page.locator(".result-card").first().locator("table").innerText(),
  ).toBe(first);
});

test("worker failures are reported distinctly and the search can be stopped", async ({
  page,
  context,
}) => {
  await ready(page);
  await context.route("**/assets/optimizerWorker-*.js", (route) =>
    route.fulfill({
      body: "throw new Error('Browser worker failure')",
      contentType: "application/javascript",
    }),
  );
  await search(page);
  await expect(page.locator("#run-status")).toContainText(
    "Browser worker failure",
  );
  await context.unroute("**/assets/optimizerWorker-*.js");
  await context.route("**/assets/optimizerWorker-*.js", (route) =>
    route.fulfill({
      body: "self.onmessage = () => {};",
      contentType: "application/javascript",
    }),
  );
  await page.getByRole("button", { name: "Find builds", exact: true }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("#run-status")).toContainText(/cancelled/i);
  await expect(
    page.getByRole("button", { name: "Find builds", exact: true }),
  ).toBeEnabled();
});
