import JSZip from "jszip";
import { readFileSync } from "node:fs";

async function main() {
  const z = await JSZip.loadAsync(readFileSync("out/OPEN-TEST.pptx"));
  const x = await z.file("ppt/slides/slide1.xml")!.async("string");
  const shapes = [...x.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)].map((m) => m[1]);
  const sp = shapes.find((s) => s.includes("grid intersection"))!;
  const paras = [...sp.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => m[1]);
  console.log(`bullets shape: ${paras.length} <a:p> paragraph(s), ${(sp.match(/<a:r>/g) ?? []).length} run(s)`);
  paras.forEach((p, i) => {
    const pPr = /<a:pPr[^>]*>/.exec(p)?.[0] ?? "(no pPr)";
    const bu = /<a:bu(?:Char|AutoNum|None)[^>]*\/?>/.exec(p)?.[0] ?? "(no bullet element)";
    const texts = [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]);
    console.log(`\n  para ${i + 1}: ${pPr}`);
    console.log(`    bullet: ${bu}`);
    console.log(`    runs(${texts.length}): ${texts.map((t) => JSON.stringify(t.slice(0, 55))).join(" , ")}`);
  });
}
main();
