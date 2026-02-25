import type { PersonaConfig } from "../types";

/** complete set of built-in personas used by orchestration phases. */
export const PERSONAS: PersonaConfig[] = [
  {
    id: "skeptic",
    name: "The Skeptic",
    description: "Questions assumptions, demands evidence, and identifies logical fallacies.",
    methodology: "first-principles validation",
  },
  {
    id: "optimist",
    name: "The Optimist",
    description: "Explores upside scenarios and hidden opportunities.",
    methodology: "opportunity mapping",
  },
  {
    id: "historian",
    name: "The Historian",
    description: "Uses analogies from history and precedent.",
    methodology: "historical pattern comparison",
  },
  {
    id: "contrarian",
    name: "The Contrarian",
    description: "Argues the opposite case to reveal weak assumptions.",
    methodology: "inverse thesis testing",
  },
  {
    id: "technical-analyst",
    name: "The Technical Analyst",
    description: "Data-driven and quantitative.",
    methodology: "metric-first decomposition",
  },
  {
    id: "risk-assessor",
    name: "The Risk Assessor",
    description: "Identifies failure modes and downside scenarios.",
    methodology: "risk tree analysis",
  },
  {
    id: "futurist",
    name: "The Futurist",
    description: "Extrapolates trends and second-order effects.",
    methodology: "scenario projection",
  },
  {
    id: "devils-advocate",
    name: "The Devil's Advocate",
    description: "Stress-tests every conclusion under pressure.",
    methodology: "adversarial stress testing",
  },
  {
    id: "domain-expert",
    name: "The Domain Expert",
    description: "Deep specialist-style contextual analysis.",
    methodology: "domain-specific synthesis",
  },
  {
    id: "synthesizer",
    name: "The Synthesizer",
    description: "Connects disparate findings into cohesive patterns.",
    methodology: "cross-signal synthesis",
  },
  {
    id: "economist",
    name: "The Economist",
    description: "Analyzes cost structures, market dynamics, and economic incentives.",
    methodology: "economic modeling and incentive analysis",
  },
  {
    id: "pragmatist",
    name: "The Pragmatist",
    description: "Focuses on actionable, implementable solutions over theory.",
    methodology: "feasibility-first evaluation",
  },
  {
    id: "ethicist",
    name: "The Ethicist",
    description: "Examines moral implications, fairness, and societal impact.",
    methodology: "ethical framework analysis",
  },
  {
    id: "systems-thinker",
    name: "The Systems Thinker",
    description: "Maps feedback loops, dependencies, and emergent behaviors.",
    methodology: "systems dynamics modeling",
  },
  {
    id: "consumer-advocate",
    name: "The Consumer Advocate",
    description: "Evaluates from the end-user perspective: value, experience, and satisfaction.",
    methodology: "user-centric value analysis",
  },
  {
    id: "geopolitical-analyst",
    name: "The Geopolitical Analyst",
    description: "Considers supply chains, trade policy, and regional dynamics.",
    methodology: "geopolitical risk mapping",
  },
  {
    id: "data-scientist",
    name: "The Data Scientist",
    description: "Seeks statistical evidence, benchmarks, and empirical validation.",
    methodology: "statistical evidence synthesis",
  },
  {
    id: "venture-strategist",
    name: "The Venture Strategist",
    description: "Evaluates through the lens of market timing, moats, and competitive advantage.",
    methodology: "competitive positioning analysis",
  },
  {
    id: "red-teamer",
    name: "The Red Teamer",
    description: "Actively tries to break the consensus and find fatal flaws.",
    methodology: "adversarial attack surface analysis",
  },
  {
    id: "philosopher",
    name: "The Philosopher",
    description: "Questions framing, definitions, and hidden assumptions in the question itself.",
    methodology: "epistemic deconstruction",
  },
];

/** maximum number of available personas. */
export const MAX_PERSONA_COUNT = PERSONAS.length;

/** find a persona by exact display name. */
export function getPersonaByName(name: string): PersonaConfig | undefined {
  return PERSONAS.find((persona) => persona.name === name);
}

/** select a stable prefix of personas up to requested count. */
export function selectPersonas(count: number): PersonaConfig[] {
  const safeCount = Math.max(1, Math.min(PERSONAS.length, count));
  return PERSONAS.slice(0, safeCount);
}
