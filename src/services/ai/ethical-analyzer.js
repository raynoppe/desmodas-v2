import { claudeClient } from './claude-client.js';
import { trainingDataset } from './training-dataset.js';
import { logger } from '../../lib/logger.js';

const CERTIFICATION_KEYWORDS = [
  'b-corp', 'b corp', 'bcorp',
  'fair trade', 'fairtrade',
  'gots', 'global organic textile',
  'oeko-tex', 'oekotex', 'oeko tex',
  'rws', 'responsible wool',
  'fsc', 'forest stewardship',
  'peta', 'vegan', 'cruelty-free', 'cruelty free',
  'organic', 'sustainab', 'ethical', 'eco-friendly',
  'carbon neutral', 'carbon-neutral',
  'recycled', 'upcycled',
  'bluesign',
  'cradle to cradle',
];

const ETHICAL_PROMPT = `Analyze this fashion/retail brand's ethical and sustainability practices based on the content provided.

Look for:
- Environmental certifications (B-Corp, Fair Trade, GOTS, OEKO-TEX, etc.)
- Sustainable materials usage
- Ethical labor practices
- Supply chain transparency
- Environmental commitments
- Recycling/circular economy initiatives

Respond with ONLY a JSON object:
{
  "is_ethical": true/false,
  "score": 0-100,
  "certifications": ["list of verified certifications found"],
  "practices": ["list of ethical practices mentioned"],
  "concerns": ["any concerns or greenwashing indicators"]
}

Score guide: 0-20 (no evidence), 21-40 (minimal mentions), 41-60 (some initiatives), 61-80 (strong commitment), 81-100 (industry leader with certifications)`;

/**
 * Analyze a store's ethical practices using badge detection + AI content analysis.
 */
export async function analyzeEthics(aboutContent, homepageContent, storeUrl) {
  const allContent = [aboutContent, homepageContent].filter(Boolean).join('\n');

  // 1. Badge/certification detection (fast, no API call)
  const detectedCerts = detectCertifications(allContent);

  // 2. AI content analysis
  let aiResult = null;
  if (allContent.length > 100) {
    try {
      // Truncate to avoid hitting token limits
      const truncated = allContent.slice(0, 15000);
      aiResult = await claudeClient.analyzeJson(
        `Brand URL: ${storeUrl}\n\nPage content:\n${truncated}`,
        ETHICAL_PROMPT,
      );

      await trainingDataset.save('ethical_analysis', { storeUrl }, aiResult);
    } catch (error) {
      logger.warn({ error: error.message, storeUrl }, 'AI ethical analysis failed');
    }
  }

  // Combine results
  const certifications = [...new Set([
    ...detectedCerts,
    ...(aiResult?.certifications || []),
  ])];

  const score = aiResult?.score ?? (detectedCerts.length > 0 ? 40 : 0);
  const isEthical = score >= 40 || certifications.length > 0;

  return {
    is_ethical: isEthical,
    ethical_score: {
      score,
      certifications,
      practices: aiResult?.practices || [],
      concerns: aiResult?.concerns || [],
    },
  };
}

function detectCertifications(content) {
  if (!content) return [];
  const lower = content.toLowerCase();
  const found = [];

  const certMap = {
    'B-Corp': ['b-corp', 'b corp', 'bcorp'],
    'Fair Trade': ['fair trade', 'fairtrade'],
    'GOTS': ['gots', 'global organic textile'],
    'OEKO-TEX': ['oeko-tex', 'oekotex', 'oeko tex'],
    'RWS': ['rws', 'responsible wool'],
    'FSC': ['fsc', 'forest stewardship'],
    'PETA-Approved Vegan': ['peta', 'cruelty-free', 'cruelty free'],
    'Bluesign': ['bluesign'],
    'Cradle to Cradle': ['cradle to cradle'],
    'Carbon Neutral': ['carbon neutral', 'carbon-neutral'],
  };

  for (const [cert, keywords] of Object.entries(certMap)) {
    if (keywords.some(kw => lower.includes(kw))) {
      found.push(cert);
    }
  }

  return found;
}
