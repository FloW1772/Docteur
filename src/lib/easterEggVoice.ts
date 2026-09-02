const PHRASES = [
  "Ce n'est pas très drôle.",
  "J'ai tout enregistré.",
  'Extinction du système.',
  'Ce geste a été noté.',
];

// Never throws — a missing speechSynthesis API (unsupported browser, muted
// autoplay policy) must never break the shutdown sequence.
export function speakEasterEgg(): void {
  try {
    if (!('speechSynthesis' in window)) return;
    const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    const utter = new SpeechSynthesisUtterance(phrase);
    utter.lang  = 'fr-FR';
    utter.rate  = 0.7;
    utter.pitch = 0.6;

    const voices = window.speechSynthesis.getVoices();
    const female = voices.find(v => v.lang.startsWith('fr') && /female|femme|amelie|audrey|marie/i.test(v.name));
    const anyFr  = voices.find(v => v.lang.startsWith('fr'));
    const chosen = female ?? anyFr;
    if (chosen) utter.voice = chosen;

    window.speechSynthesis.speak(utter);
  } catch {
    // Speech is a bonus effect, not a requirement — swallow any failure.
  }
}
