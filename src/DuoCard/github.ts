// A day on the contribution graph: its date, and the shade GitHub gives it, 0 (none) to 4.
export type ContributionDay = { date: string; level: number };

/**
 * The last year of contributions, live. GitHub's own API needs a token, which a public page cannot
 * hold, so this reads grubersjoe's github-contributions-api: it serves the profile's public
 * calendar, cached for about an hour, and allows browser requests. To use an endpoint of your own
 * instead, return the same shape from it.
 */
export async function fetchContributions(login: string, signal?: AbortSignal): Promise<ContributionDay[]> {
  const response = await fetch(`https://github-contributions-api.jogruber.de/v4/${encodeURIComponent(login)}?y=last`, { signal });
  if (!response.ok) throw new Error(`Contributions for ${login}: HTTP ${response.status}`);
  const data = (await response.json()) as { contributions: ContributionDay[] };
  return data.contributions.map(({ date, level }) => ({ date, level }));
}
