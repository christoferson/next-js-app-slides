/**
 * §1.1 independent-reader check: an unrelated OOXML consumer must be able to read
 * the deck. Not a substitute for the PowerPoint open-test, but it catches
 * structurally-broken packages that our own regex assertions would miss.
 */
import { parseOffice } from "officeparser";
import { join } from "node:path";

const files = ["verify-pptx.pptx", "probe5-multimaster.pptx", "probe5-mixed.pptx", "probe4-master.pptx"];

async function main() {
  for (const f of files) {
    try {
      const res: any = await parseOffice(join(process.cwd(), "out", f));
      const s: string = typeof res === "string" ? res : res.toText();
      console.log(`PASS ${f}: ${s.length} chars extracted`);
      if (f === "verify-pptx.pptx") {
        console.log(`     CJK round-trip: ${/日本語も確認/.test(s)}`);
        console.log(`     bullets text:   ${/Point one/.test(s)}`);
        console.log(`     font specimens: ${(s.match(/Handgloves/g) ?? []).length} of 16`);
        console.log(`     speaker notes:  ${/Speaker notes round-trip probe/.test(s)}`);
      }
    } catch (e: any) {
      console.log(`FAIL ${f}: ${e?.message}`);
      process.exitCode = 1;
    }
  }
}

main();
