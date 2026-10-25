/**
 * NFL team colors and logo images, from nflverse's teams_colors_logos.csv
 * (https://github.com/nflverse/nflverse-pbp). Logos are the teams' own marks, shown to identify
 * the teams in games; the website serves copies downloaded at build time (scripts/fetch-headshots.mjs).
 */
export interface NflTeamInfo { city: string; name: string; color: string; color2: string; logo: string }

export const NFL_TEAM_INFO: Record<string, NflTeamInfo> = {
  ARI: { city: 'Arizona', name: 'Cardinals', color: '#97233F', color2: '#000000', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/ari.png' },
  ATL: { city: 'Atlanta', name: 'Falcons', color: '#A71930', color2: '#000000', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/atl.png' },
  BAL: { city: 'Baltimore', name: 'Ravens', color: '#241773', color2: '#9E7C0C', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/bal.png' },
  BUF: { city: 'Buffalo', name: 'Bills', color: '#00338D', color2: '#C60C30', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/buf.png' },
  CAR: { city: 'Carolina', name: 'Panthers', color: '#0085CA', color2: '#000000', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500-dark/car.png' },
  CHI: { city: 'Chicago', name: 'Bears', color: '#0B162A', color2: '#E64100', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/chi.png' },
  CIN: { city: 'Cincinnati', name: 'Bengals', color: '#FB4F14', color2: '#000000', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/cin.png' },
  CLE: { city: 'Cleveland', name: 'Browns', color: '#FF3C00', color2: '#311D00', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/cle.png' },
  DAL: { city: 'Dallas', name: 'Cowboys', color: '#002244', color2: '#B0B7BC', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/dal.png' },
  DEN: { city: 'Denver', name: 'Broncos', color: '#002244', color2: '#FB4F14', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/den.png' },
  DET: { city: 'Detroit', name: 'Lions', color: '#0076B6', color2: '#B0B7BC', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/det.png' },
  GB: { city: 'Green Bay', name: 'Packers', color: '#203731', color2: '#FFB612', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/gb.png' },
  HOU: { city: 'Houston', name: 'Texans', color: '#03202F', color2: '#A71930', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/hou.png' },
  IND: { city: 'Indianapolis', name: 'Colts', color: '#002C5F', color2: '#A5ACAF', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/ind.png' },
  JAX: { city: 'Jacksonville', name: 'Jaguars', color: '#006778', color2: '#000000', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/jax.png' },
  KC: { city: 'Kansas City', name: 'Chiefs', color: '#E31837', color2: '#FFB612', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/kc.png' },
  LAC: { city: 'Los Angeles', name: 'Chargers', color: '#007BC7', color2: '#FFC20E', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/lac.png' },
  LAR: { city: 'Los Angeles', name: 'Rams', color: '#003594', color2: '#FFD100', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/lar.png' },
  LV: { city: 'Las Vegas', name: 'Raiders', color: '#000000', color2: '#A5ACAF', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/lv.png' },
  MIA: { city: 'Miami', name: 'Dolphins', color: '#008E97', color2: '#F58220', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/mia.png' },
  MIN: { city: 'Minnesota', name: 'Vikings', color: '#4F2683', color2: '#FFC62F', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/min.png' },
  NE: { city: 'New England', name: 'Patriots', color: '#002244', color2: '#C60C30', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/ne.png' },
  NO: { city: 'New Orleans', name: 'Saints', color: '#D3BC8D', color2: '#000000', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/no.png' },
  NYG: { city: 'New York', name: 'Giants', color: '#0B2265', color2: '#A71930', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/nyg.png' },
  NYJ: { city: 'New York', name: 'Jets', color: '#003F2D', color2: '#000000', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/nyj.png' },
  PHI: { city: 'Philadelphia', name: 'Eagles', color: '#004C54', color2: '#A5ACAF', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/phi.png' },
  PIT: { city: 'Pittsburgh', name: 'Steelers', color: '#000000', color2: '#FFB612', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/pit.png' },
  SEA: { city: 'Seattle', name: 'Seahawks', color: '#002244', color2: '#69BE28', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/sea.png' },
  SF: { city: 'San Francisco', name: '49ers', color: '#AA0000', color2: '#B3995D', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/sf.png' },
  TB: { city: 'Tampa Bay', name: 'Buccaneers', color: '#A71930', color2: '#322F2B', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/tb.png' },
  TEN: { city: 'Tennessee', name: 'Titans', color: '#4495D2', color2: '#D50A0A', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/ten.png' },
  WAS: { city: 'Washington', name: 'Commanders', color: '#5A1414', color2: '#FFB612', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/wsh.png' },
};
