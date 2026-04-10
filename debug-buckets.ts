// Debug: see which buckets match for the Glory scenario
const INFO_BUCKETS = [
  { name: "quantity", keywords: ["quantity", "how many", "number of", "count", "total", "pieces"] },
  { name: "print_sides", keywords: ["print side", "1 or 2", "one or two", "1-sided", "2-sided", "single side", "double side", "front and back", "front only"] },
  { name: "design", keywords: ["design", "artwork", "logo", "graphic", "layout"] },
  { name: "color", keywords: ["color", "colour", "shade", "navy", "black", "white"] },
  { name: "size", keywords: ["size", "sizing", "small", "medium", "large", "xl", "2xl", "3xl"] },
  { name: "timeline", keywords: ["when do you need", "deadline", "by when", "rush", "turnaround", "how soon"] },
  { name: "budget", keywords: ["budget", "price range", "spending", "afford"] },
  { name: "contact_info", keywords: ["email", "phone", "number", "reach you", "best way to contact"] },
  { name: "event_type", keywords: ["what kind of event", "what type of event", "what event", "planning this for", "occasion", "what are these for"] },
  { name: "purpose", keywords: ["what are you looking for", "what do you need", "interested in", "looking for"] },
];
const matchBuckets = (text: string): Set<string> => {
  const lower = text.toLowerCase();
  const matched = new Set<string>();
  for (const bucket of INFO_BUCKETS) {
    if (bucket.keywords.some(kw => lower.includes(kw))) matched.add(bucket.name);
  }
  return matched;
};

// Glory scenario
const priorMsg = "Hey Glory, I know you asked about embroidery for your brand a while back. We've done tons of cool projects since then. Thinking embroidered polos or hats? They typically run roughly $10-28 each, depending on quantity. Still interested in leveling up your gear?";
const composedMsg = "Great question! The $10-28 range covers both canvas and non-canvas options. Canvas hats run closer to the higher end. How many pieces are you thinking?";
const inboundMsg = "$10 to $28 plus canvas or without canvas?";

console.log("=== GLORY SCENARIO ===");
console.log("Prior outbound buckets:", matchBuckets(priorMsg));
console.log("Composed buckets:", matchBuckets(composedMsg));
console.log("Inbound buckets:", matchBuckets(inboundMsg));

const composedBuckets = matchBuckets(composedMsg);
const priorBuckets = matchBuckets(priorMsg);
const inboundBuckets = matchBuckets(inboundMsg);
const overlap = Array.from(composedBuckets).filter(b => priorBuckets.has(b));
const nonExemptOverlap = overlap.filter(b => !inboundBuckets.has(b));
console.log("Overlap:", overlap);
console.log("Non-exempt overlap:", nonExemptOverlap);

// Timeline scenario
console.log("\n=== TIMELINE SCENARIO ===");
const priorTimeline = "When do you need these by? Rush orders are possible!";
const composedTimeline = "Two weeks is totally doable! Standard turnaround is 7-10 business days. When exactly is your event?";
const inboundTimeline = "I need them in about two weeks, is that possible?";

console.log("Prior outbound buckets:", matchBuckets(priorTimeline));
console.log("Composed buckets:", matchBuckets(composedTimeline));
console.log("Inbound buckets:", matchBuckets(inboundTimeline));

const composedBuckets2 = matchBuckets(composedTimeline);
const priorBuckets2 = matchBuckets(priorTimeline);
const inboundBuckets2 = matchBuckets(inboundTimeline);
const overlap2 = Array.from(composedBuckets2).filter(b => priorBuckets2.has(b));
const nonExemptOverlap2 = overlap2.filter(b => !inboundBuckets2.has(b));
console.log("Overlap:", overlap2);
console.log("Non-exempt overlap:", nonExemptOverlap2);
