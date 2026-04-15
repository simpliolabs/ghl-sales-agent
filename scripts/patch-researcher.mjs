import { readFileSync, writeFileSync } from 'fs';

const filePath = '/home/ubuntu/adorb-outreach/server/researcher.ts';
let content = readFileSync(filePath, 'utf8');

const oldBlock = `  const researchInput = \`
LEAD DATA:
- Name: \${lead.name || "Unknown"}
- Business: \${lead.businessName || "Unknown"}
- Website: \${lead.website || "N/A"}
- Email: \${lead.email || "N/A"}
- Source: \${lead.source || "Unknown"}
- Segment: \${lead.omnisendSegment || "Unclassified"}
- Pipeline stage: \${lead.pipelineStage || "Unknown"}
- Existing Research: \${JSON.stringify(lead.researchData || {})}`;

const newBlock = `  // Sanitize researchData before injecting into the LLM prompt.
  // The old GHL sub-account had internal project management fields (Project Name, Project Business Name,
  // etc.) with value "The CEO Store" that got migrated to ALL imported contacts. Strip these so the
  // LLM doesn't infer them as the lead's business name.
  const ADORB_INTERNAL_FIELDS_R = new Set([
    'Project Name', 'Project Business Name', 'Project Business Email',
    'Project Business Phone Number', 'Project Business Point Of Contact',
    'Project City', 'Project Full Address', 'Project State', 'Project SOP Link',
  ]);
  // Also strip the raw oldGhlCustomFields array — it contains unmapped field IDs with values like
  // "The CEO Store" that the LLM will misinterpret as the lead's business name.
  const sanitizedResearchData = (() => {
    const rd = (lead.researchData as Record<string, unknown>) || {};
    const tc = (rd.transferredContact as Record<string, unknown>) || {};
    const resolvedRaw = (tc.resolvedCustomFields as Record<string, unknown>) || {};
    const resolvedClean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(resolvedRaw)) {
      if (!ADORB_INTERNAL_FIELDS_R.has(k)) resolvedClean[k] = v;
    }
    // Build a clean copy of transferredContact without oldGhlCustomFields (raw unmapped fields)
    const tcClean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tc)) {
      if (k !== 'oldGhlCustomFields') tcClean[k] = v;
    }
    tcClean.resolvedCustomFields = resolvedClean;
    return { ...rd, transferredContact: tcClean };
  })();

  const researchInput = \`
LEAD DATA:
- Name: \${lead.name || "Unknown"}
- Business: \${lead.businessName || "Unknown"}
- Website: \${lead.website || "N/A"}
- Email: \${lead.email || "N/A"}
- Source: \${lead.source || "Unknown"}
- Segment: \${lead.omnisendSegment || "Unclassified"}
- Pipeline stage: \${lead.pipelineStage || "Unknown"}
- Existing Research: \${JSON.stringify(sanitizedResearchData)}`;

if (!content.includes(oldBlock)) {
  console.error('ERROR: Could not find the target block to replace!');
  console.error('Looking for:', oldBlock.substring(0, 100));
  process.exit(1);
}

content = content.replace(oldBlock, newBlock);
writeFileSync(filePath, content, 'utf8');
console.log('✅ researcher.ts patched successfully');
