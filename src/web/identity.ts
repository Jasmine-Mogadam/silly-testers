export interface BotIdentity {
  agentId: string;
  displayName: string;
  emoji: string;
  color: string;
}

const ADJECTIVES = [
  'sneaky', 'caffeinated', 'grumpy', 'blazing', 'wobbly', 'polite', 'feral',
  'sleepy', 'rogue', 'anxious', 'dramatic', 'confused', 'nimble', 'ancient',
  'frantic', 'haunted', 'suspicious', 'neon', 'quantum', 'cosmic', 'tiny',
  'majestic', 'soggy', 'phantom', 'ruthless', 'gentle', 'cryptic', 'radiant',
  'jumpy', 'loyal', 'chaotic', 'serene', 'bold', 'timid', 'spooky',
  'electric', 'fuzzy', 'cursed', 'brave', 'devious', 'silent', 'rowdy',
  'ancient', 'gleaming', 'moody', 'frenzied', 'calm', 'restless', 'fearless',
  'clumsy', 'crafty', 'dazzling', 'eerie', 'fluffy', 'gloomy', 'hyper',
  'jittery', 'keen', 'lazy', 'manic', 'nervous', 'ornery', 'peppy',
  'quirky', 'rabid', 'salty', 'tenacious', 'unhinged', 'vicious', 'wily',
  'xenial', 'yappy', 'zany', 'absurd', 'bonkers', 'covert', 'daring',
  'elusive', 'furtive', 'goofy', 'hollow', 'itchy', 'janky', 'kinetic',
  'lurking', 'murky', 'nocturnal', 'oblique', 'prowling', 'quivering',
  'reckless', 'stealthy', 'turbulent', 'unstable', 'volatile', 'wandering',
];

const ANIMALS = [
  'capybara', 'axolotl', 'pangolin', 'quokka', 'tapir', 'narwhal',
  'binturong', 'fossa', 'okapi', 'meerkat', 'wombat', 'platypus',
  'manatee', 'kinkajou', 'ocelot', 'porcupine', 'ferret', 'mongoose',
  'lemur', 'gibbon', 'ibis', 'flamingo', 'cassowary', 'pelican',
  'toucan', 'armadillo', 'aardvark', 'hedgehog', 'marmot', 'vole',
  'shrew', 'dingo', 'jackal', 'coyote', 'wolverine', 'badger',
  'otter', 'skunk', 'raccoon', 'capuchin', 'mandrill', 'tapir',
  'quetzal', 'caracal', 'serval', 'margay', 'clouded-leopard',
  'binturong', 'coati', 'peccary', 'viscacha', 'chinchilla',
  'numbat', 'quoll', 'bilby', 'potoroo', 'bettong', 'dunnart',
  'kea', 'kakapo', 'takahe', 'tuatara', 'gecko', 'skink',
];

const EMOJIS = [
  '🤖', '👾', '👻', '🕵️', '🧙', '👨‍🚀', '🏴‍☠️', '🧛', '🦾', '🤠',
  '🥷', '🧟', '👽', '🤡', '💀', '🦹', '🧝', '🧞', '🧜', '🦸',
  '🐉', '🦊', '🐺', '🦝', '🐸', '🦉', '🦇', '🐙', '🦑', '🦠',
];

const COLOR_PALETTE = [
  'hsl(210,65%,45%)',
  'hsl(340,60%,48%)',
  'hsl(140,55%,38%)',
  'hsl(30,70%,48%)',
  'hsl(270,55%,50%)',
  'hsl(180,55%,38%)',
  'hsl(0,60%,48%)',
  'hsl(60,55%,40%)',
  'hsl(300,50%,48%)',
  'hsl(195,60%,42%)',
  'hsl(15,65%,48%)',
  'hsl(240,55%,50%)',
  'hsl(90,50%,40%)',
  'hsl(355,58%,50%)',
  'hsl(165,52%,38%)',
  'hsl(45,68%,44%)',
  'hsl(285,52%,48%)',
  'hsl(120,48%,40%)',
  'hsl(225,58%,48%)',
  'hsl(75,52%,40%)',
];

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Seeded shuffle — produces a stable per-run ordering from a seed number
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = [...arr];
  let s = seed;
  for (let i = result.length - 1; i > 0; i--) {
    s = (Math.imul(1664525, s) + 1013904223) | 0;
    const j = Math.abs(s) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

let shuffledAdj: string[] = ADJECTIVES;
let shuffledAni: string[] = ANIMALS;
let nameIndex = 0;
const identityMap = new Map<string, BotIdentity>();

/**
 * Call once at run start with a random seed to shuffle the word lists.
 * Same agentIds will get fresh identities each run.
 */
export function initIdentities(seed = Date.now()): void {
  shuffledAdj = seededShuffle(ADJECTIVES, seed);
  shuffledAni = seededShuffle(ANIMALS, seed ^ 0xdeadbeef);
  nameIndex = 0;
  identityMap.clear();
}

export function ensureIdentity(agentId: string): BotIdentity {
  if (identityMap.has(agentId)) {
    return identityMap.get(agentId)!;
  }

  const adjIdx = nameIndex % shuffledAdj.length;
  const aniIdx = nameIndex % shuffledAni.length;
  nameIndex++;

  const hash = simpleHash(agentId);
  const identity: BotIdentity = {
    agentId,
    displayName: `${shuffledAdj[adjIdx]}-${shuffledAni[aniIdx]}`,
    emoji: EMOJIS[hash % EMOJIS.length],
    color: COLOR_PALETTE[hash % COLOR_PALETTE.length],
  };

  identityMap.set(agentId, identity);
  return identity;
}

export function getIdentityMap(): Map<string, BotIdentity> {
  return identityMap;
}
