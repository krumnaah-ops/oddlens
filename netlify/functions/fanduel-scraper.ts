export interface FanDuelRunner {
  selectionId: number;
  runnerName: string;
  winRunnerOdds?: {
    americanDisplayOdds?: {
      americanOdds: number;
    }
  };
}

export interface FanDuelMarket {
  marketId: string;
  eventId: number;
  marketName: string;
  marketType: string;
  runners?: FanDuelRunner[];
}

export interface FanDuelEvent {
  eventId: number;
  name: string;
  openDate: string;
}

export interface FanDuelScrapedProps {
  events: Record<string, FanDuelEvent>;
  markets: FanDuelMarket[];
}

export function isTeamMatch(fdEventName: string, homeTeam: string, awayTeam: string): boolean {
  const name = fdEventName.toLowerCase();
  const h = homeTeam.toLowerCase();
  const a = awayTeam.toLowerCase();

  // 1. Direct contains check
  if (name.includes(h) && name.includes(a)) {
    return true;
  }

  // 2. Split by space and check last words (mascots/city names)
  const hParts = h.split(' ');
  const aParts = a.split(' ');
  const hLast = hParts[hParts.length - 1];
  const aLast = aParts[aParts.length - 1];

  if (name.includes(hLast) && name.includes(aLast)) {
    return true;
  }

  // 3. Check first parts (e.g. "Los Angeles" or "Chicago")
  const hFirst = hParts[0];
  const aFirst = aParts[0];
  if (name.includes(hFirst) && name.includes(aFirst)) {
    return true;
  }

  return false;
}

export async function fetchFanDuelProps(): Promise<FanDuelScrapedProps> {
  const url = 'https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?betexRegion=GBR&capiJurisdiction=intl&currencyCode=USD&_ak=FhMFpcPWXMeyZxOx&page=CUSTOM&customPageId=mlb';
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://sportsbook.fanduel.com',
        'Referer': 'https://sportsbook.fanduel.com/'
      }
    });

    if (!res.ok) {
      console.warn(`FanDuel API returned status ${res.status}`);
      return { events: {}, markets: [] };
    }

    const data = await res.json();
    const events: Record<string, FanDuelEvent> = data.attachments?.events || {};
    const marketsRaw: Record<string, FanDuelMarket> = data.attachments?.markets || {};
    const markets = Object.values(marketsRaw).filter(m => m.marketType === 'TO_HIT_A_HOME_RUN');

    console.log(`[FanDuel Scraper] Scraped ${Object.keys(events).length} events and found ${markets.length} home run markets.`);
    return { events, markets };
  } catch (err) {
    console.error('[FanDuel Scraper] Error fetching from FanDuel:', err);
    return { events: {}, markets: [] };
  }
}

export function mergeFanDuelPropsIntoEvent(
  eventProps: any,
  fdData: FanDuelScrapedProps,
  homeTeam: string,
  awayTeam: string,
  eventId: string
): any {
  // Find the matching FanDuel event
  const fdEvents = Object.values(fdData.events);
  const matchingEvent = fdEvents.find(e => isTeamMatch(e.name, homeTeam, awayTeam));

  if (!matchingEvent) {
    console.log(`[FanDuel Scraper] No matching FanDuel event found for ${awayTeam} @ ${homeTeam}`);
    return eventProps;
  }

  // Find the home run market for this event
  const matchingMarket = fdData.markets.find(m => m.eventId === matchingEvent.eventId);

  if (!matchingMarket || !matchingMarket.runners) {
    console.log(`[FanDuel Scraper] Matching event found for ${awayTeam} @ ${homeTeam} but no active To Hit A Home Run market is posted yet on FanDuel.`);
    return eventProps;
  }

  // Convert FanDuel runners to Outcomes structure
  const outcomes = matchingMarket.runners
    .filter(r => r.runnerName && r.winRunnerOdds?.americanDisplayOdds?.americanOdds)
    .map(r => ({
      name: "Over",
      description: r.runnerName,
      price: r.winRunnerOdds!.americanDisplayOdds!.americanOdds,
      point: 0.5
    }));

  if (outcomes.length === 0) {
    console.log(`[FanDuel Scraper] Home run market has no active runners with odds for ${awayTeam} @ ${homeTeam}`);
    return eventProps;
  }

  const fdBookmaker = {
    key: "fanduel",
    title: "FanDuel",
    markets: [
      {
        key: "batter_home_runs",
        outcomes
      }
    ]
  };

  // Build or update propsData
  let updatedProps = eventProps;
  if (!updatedProps) {
    updatedProps = {
      id: eventId,
      sport_key: "baseball_mlb",
      sport_title: "MLB",
      commence_time: new Date().toISOString(),
      home_team: homeTeam,
      away_team: awayTeam,
      bookmakers: []
    };
  }

  if (!updatedProps.bookmakers) {
    updatedProps.bookmakers = [];
  }

  // Filter out any existing fanduel bookmaker and push our fresh scraped one
  updatedProps.bookmakers = updatedProps.bookmakers.filter((b: any) => b.key !== 'fanduel');
  updatedProps.bookmakers.push(fdBookmaker);

  console.log(`[FanDuel Scraper] Successfully merged ${outcomes.length} FanDuel home run odds into event ${eventId}`);
  return updatedProps;
}
