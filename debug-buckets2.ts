// Debug: check word overlap for the failing scenarios
const stopWords = new Set(["the", "a", "an", "is", "are", "do", "you", "your", "we", "our", "for", "to", "in", "of", "and", "or", "this", "that", "it", "i", "me", "my", "can", "with", "but", "not", "was", "has", "had", "have", "been", "will"]);

function getSignificantWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w))
  );
}

// Glory scenario
console.log("=== GLORY SCENARIO ===");
const priorGlory = "Hey Glory, I know you asked about embroidery for your brand a while back. We've done tons of cool projects since then. Thinking embroidered polos or hats? They typically run roughly $10-28 each, depending on quantity. Still interested in leveling up your gear?";
const inboundGlory = "$10 to $28 plus canvas or without canvas?";
const inboundWords = getSignificantWords(inboundGlory);
const priorWords = priorGlory.toLowerCase().split(/\s+/).filter(w => w.length > 2);
const priorWordOverlap = priorWords.filter(w => inboundWords.has(w));
console.log("Inbound significant words:", inboundWords);
console.log("Prior words (len>2):", priorWords);
console.log("Overlap words:", priorWordOverlap);
console.log("Overlap count:", priorWordOverlap.length);
console.log("isReplyToPrior:", priorWordOverlap.length >= 2 || (priorWordOverlap.length >= 1 && inboundWords.size <= 5));

// Timeline scenario
console.log("\n=== TIMELINE SCENARIO ===");
const priorTimeline = "When do you need these by? Rush orders are possible!";
const inboundTimeline = "I need them in about two weeks, is that possible?";
const inboundWords2 = getSignificantWords(inboundTimeline);
const priorWords2 = priorTimeline.toLowerCase().split(/\s+/).filter(w => w.length > 2);
const priorWordOverlap2 = priorWords2.filter(w => inboundWords2.has(w));
console.log("Inbound significant words:", inboundWords2);
console.log("Prior words (len>2):", priorWords2);
console.log("Overlap words:", priorWordOverlap2);
console.log("Overlap count:", priorWordOverlap2.length);
console.log("isReplyToPrior:", priorWordOverlap2.length >= 2 || (priorWordOverlap2.length >= 1 && inboundWords2.size <= 5));

// First test scenario (should STILL flag)
console.log("\n=== FIRST TEST (should flag) ===");
const priorFirst = "What kind of event are you planning this for?";
const inboundFirst = "I need some t-shirts";
const inboundWords3 = getSignificantWords(inboundFirst);
const priorWords3 = priorFirst.toLowerCase().split(/\s+/).filter(w => w.length > 2);
const priorWordOverlap3 = priorWords3.filter(w => inboundWords3.has(w));
console.log("Inbound significant words:", inboundWords3);
console.log("Prior words (len>2):", priorWords3);
console.log("Overlap words:", priorWordOverlap3);
console.log("Overlap count:", priorWordOverlap3.length);
console.log("isReplyToPrior:", priorWordOverlap3.length >= 2 || (priorWordOverlap3.length >= 1 && inboundWords3.size <= 5));

// "STILL flags" test scenario
console.log("\n=== STILL FLAGS TEST ===");
const priorStill = "What kind of event are you planning this for?";
const inboundStill = "How much do custom shirts cost?";
const inboundWords4 = getSignificantWords(inboundStill);
const priorWords4 = priorStill.toLowerCase().split(/\s+/).filter(w => w.length > 2);
const priorWordOverlap4 = priorWords4.filter(w => inboundWords4.has(w));
console.log("Inbound significant words:", inboundWords4);
console.log("Prior words (len>2):", priorWords4);
console.log("Overlap words:", priorWordOverlap4);
console.log("Overlap count:", priorWordOverlap4.length);
console.log("isReplyToPrior:", priorWordOverlap4.length >= 2 || (priorWordOverlap4.length >= 1 && inboundWords4.size <= 5));
