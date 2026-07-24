import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = join(projectRoot, "dist");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const file of ["index.html", "styles.css", "AGENT_GUIDE.md"]) {
  await cp(join(projectRoot, file), join(outputDirectory, file));
}

await cp(join(projectRoot, "src"), join(outputDirectory, "src"), {
  recursive: true,
});
await writeFile(join(outputDirectory, ".nojekyll"), "", "utf8");

process.stdout.write("GitHub Pages artifact built in dist/\n");
