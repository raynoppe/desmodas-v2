import { BASE_COLOURS, COLOUR_MAP } from '../../config/colours.js';
import { claudeClient } from './claude-client.js';
import { trainingDataset } from './training-dataset.js';
import { logger } from '../../lib/logger.js';

const COLOUR_PROMPT = `Given a product colour name, map it to exactly one of these base colours:
${BASE_COLOURS.join(', ')}

If the item has multiple colours (e.g., "blue and white stripe"), return "multi".
If you cannot determine a colour, return null.

Respond with ONLY a JSON object: {"base_colour": "the-colour-or-null"}`;

/**
 * Map a product colour name to a base colour from the fixed palette.
 * Uses a three-tier approach:
 * 1. Static lookup in COLOUR_MAP
 * 2. Base colour substring match
 * 3. Claude API fallback for unusual names
 */
export async function mapColourToBase(colourName) {
  if (!colourName) return null;

  const normalised = colourName.toLowerCase().trim();

  // 1. Direct match to base colour
  if (BASE_COLOURS.includes(normalised)) {
    return normalised;
  }

  // 2. Static lookup
  if (COLOUR_MAP[normalised]) {
    return COLOUR_MAP[normalised];
  }

  // 3. Check if colour name contains a base colour
  for (const base of BASE_COLOURS) {
    if (normalised.includes(base)) {
      return base;
    }
  }

  // 4. Check for multi-colour indicators
  const multiIndicators = [' and ', ' & ', '/', 'stripe', 'striped', 'plaid', 'check', 'floral', 'print', 'multi', 'rainbow', 'mixed', 'pattern'];
  if (multiIndicators.some(i => normalised.includes(i))) {
    return 'multi';
  }

  // 5. Try each word in the colour name against the static map
  const words = normalised.split(/[\s-]+/);
  for (const word of words) {
    if (BASE_COLOURS.includes(word)) return word;
    if (COLOUR_MAP[word]) return COLOUR_MAP[word];
  }

  // 6. Claude API fallback for truly unusual names
  try {
    const result = await claudeClient.analyzeJson(
      `Colour name: "${colourName}"`,
      COLOUR_PROMPT,
      { maxTokens: 100 }
    );

    const baseColour = result?.base_colour;
    if (baseColour && BASE_COLOURS.includes(baseColour)) {
      // Save to training dataset for future local model
      await trainingDataset.save('colour_mapping', { colourName }, { base_colour: baseColour });
      logger.debug({ original: colourName, mapped: baseColour }, 'AI mapped colour');
      return baseColour;
    }
  } catch (error) {
    logger.warn({ error: error.message, colourName }, 'AI colour mapping failed');
  }

  return null;
}
