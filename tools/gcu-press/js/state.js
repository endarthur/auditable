// Global state for GCU Press

const $ = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => [...(p || document).querySelectorAll(s)];

const GP = {
  editor: null,
  source: '',
  pages: [],
  pageSpec: { w: 595, h: 842, margin: { t: 72, b: 72, l: 72, r: 72 } },
  font: { family: 'Georgia, serif', size: 11 },
  zoom: 1,
  dirty: false,
  projectId: null,
  projectName: 'untitled',
  typesetTimer: null,
};

const STARTER = `# The Fable of the Dragon-Tyrant

Once upon a time, a dragon of staggering dimensions tyrannized the kingdom. Covered with thick black scales, its eyes glowed with hate, and from its terrible jaws flowed an incessant stream of evil-smelling yellowish-green slime. It demanded from the kingdom a gruesome tribute: to satisfy its enormous appetite, ten thousand men and women had to be delivered every evening at the foot of the mountain where the dragon-tyrant lived.

Sometimes the dragon would devour these unfortunate souls upon arrival; sometimes it would lock them up in the mountain where they would wither away for months or years before eventually being consumed.

## The Kingdom's Response

The kingdom had tried many times to fight the dragon. Valiant warriors, brave and true, had been sent to slay it. But the dragon's scales were hard as steel, and no sword or arrow could pierce them. The warriors were swatted aside like flies.

Over time, the kingdom came to accept the dragon as a fact of life. Philosophers argued that the dragon was necessary, that it gave meaning to life. Theologians maintained that the dragon was divine punishment. The people went about their days, tried not to think about the mountain, and consoled themselves with the thought that at least they had not yet been chosen.

### The Cost of Acceptance

But the cost was real. Every day, ten thousand people disappeared into the mountain. Families were torn apart. The old and the sick were often selected first, but no one was truly safe. The dragon's appetite was insatiable, and its demands only grew with time.

Some questioned whether this was truly the best of all possible worlds. A few brave voices whispered that perhaps the dragon could be defeated, if only the kingdom would commit its full resources to the task. But these voices were drowned out by the chorus of resignation.

## A New Hope

Then one day, a young scholar made a discovery. Deep in the ancient archives, she found references to a material harder than the dragon's scales. If enough of it could be gathered and fashioned into a weapon, the dragon might finally be vulnerable.

The scholar presented her findings to the king. At first, there was skepticism. The court advisors pointed out the enormous cost of such an undertaking. The military leaders doubted it would work. But the scholar was persistent, and the evidence was compelling.

After long deliberation, the king authorized the project. Mines were opened, forges were built, and the finest craftsmen in the kingdom set to work. It would take years, perhaps decades, but for the first time in living memory, there was hope.`;
