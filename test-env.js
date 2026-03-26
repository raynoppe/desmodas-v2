import dotenv from 'dotenv';
const result = dotenv.config();
if (result.error) {
  console.log('Dotenv error:', result.error);
} else {
  console.log('Parsed keys:', Object.keys(result.parsed).join(', '));
  console.log('ANTHROPIC_API_KEY in parsed:', 'ANTHROPIC_API_KEY' in result.parsed);
  console.log('ANTHROPIC_API_KEY value starts with:', result.parsed.ANTHROPIC_API_KEY?.slice(0, 15));
}
