/**
 * The TONES registry.
 *
 * Tone is the ONLY brand-derived material allowed into an LLM prompt (CLAUDE.md §7). The reason is
 * a clean split: tone describes *how the words should sound*, which is content guidance; colours,
 * fonts, and zones describe *how the slide should look*, which the template system owns entirely.
 * Keeping visual vocabulary out of prompts is what makes "on-brand by construction" a testable
 * property rather than a hope — the model cannot contradict the brand's appearance if it was never
 * told what that appearance is.
 *
 * `promptFragment` is therefore written to be prompt-safe by construction: no hex, no font name,
 * no coordinate, no asset id. `tests/prompt-purity` (§7) asserts that over the whole registry, so
 * a future entry that sneaks in "use the brand's blue" fails the build.
 */

export interface ToneDescriptor {
  id: string;
  displayName: string;
  description: string;
  /**
   * Injected verbatim into prompts. MUST contain no visual vocabulary — see the header note.
   * Written as an instruction to the model, not as a label.
   */
  promptFragment: string;
  /** Seeds the brand editor's trait chips; the user can edit freely afterwards. */
  suggestedTraits: readonly string[];
}

export const TONES: readonly ToneDescriptor[] = [
  {
    id: "executive",
    displayName: "Executive",
    description: "Direct and decision-oriented. Leads with the conclusion.",
    promptFragment:
      "Write for senior decision-makers. Lead with the conclusion, then support it. Prefer short " +
      "declarative sentences. Quantify claims where evidence allows. Never hedge with phrases " +
      "like \"it seems\" or \"we believe\".",
    suggestedTraits: ["direct", "decisive", "quantified"],
  },
  {
    id: "consultative",
    displayName: "Consultative",
    description: "Structured and analytical. Frames trade-offs explicitly.",
    promptFragment:
      "Write as an advisor presenting analysis. Make the reasoning visible: state the situation, " +
      "the implication, then the recommendation. Name trade-offs explicitly rather than " +
      "presenting one option as obvious.",
    suggestedTraits: ["structured", "analytical", "balanced"],
  },
  {
    id: "technical",
    displayName: "Technical",
    description: "Precise and concrete. Assumes a knowledgeable audience.",
    promptFragment:
      "Write for a technically fluent audience. Use precise terminology without expanding it. " +
      "Prefer concrete mechanisms and measurements over general description. Omit motivational " +
      "framing.",
    suggestedTraits: ["precise", "concrete", "unadorned"],
  },
  {
    id: "conversational",
    displayName: "Conversational",
    description: "Plain-spoken and warm. Reads like a person talking.",
    promptFragment:
      "Write plainly, as if explaining to a colleague. Use everyday words and the active voice. " +
      "Contractions are fine. Avoid corporate abstractions and stock phrases.",
    suggestedTraits: ["plain", "warm", "human"],
  },
  {
    id: "visionary",
    displayName: "Visionary",
    description: "Forward-looking and thematic. Builds toward an argument.",
    promptFragment:
      "Write to build conviction about a direction. Connect each point to the larger argument. " +
      "Favour vivid, specific language over superlatives, and ground every claim in something " +
      "concrete rather than asserting significance.",
    suggestedTraits: ["ambitious", "thematic", "specific"],
  },
];

const BY_ID: ReadonlyMap<string, ToneDescriptor> = new Map(TONES.map((t) => [t.id, t]));

export const resolveTone = (id: string): ToneDescriptor | undefined => BY_ID.get(id);

export const isKnownToneId = (id: string): boolean => BY_ID.has(id);

export const DEFAULT_TONE_ID = "consultative";

/**
 * Words a brand never wants to see. Seeds the editor; the user's list replaces this entirely.
 * These reach prompts as *prohibitions*, which is content guidance and therefore permitted (§7).
 */
export const DEFAULT_BANNED_WORDS: readonly string[] = [
  "synergy", "leverage", "disrupt", "paradigm", "best-in-class", "world-class",
  "game-changing", "revolutionary", "seamless", "robust",
];
