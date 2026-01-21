export const TOTAL_NUMBERS = 90;

export const SUPPORT_PHONE = "12093130014";

export const NICKNAMES: Record<number, string> = {
  1: "Kelly's Eye", 
  2: "One Little Duck", 
  3: "Cup of Tea", 
  4: "Knock at the Door", 
  5: "Man Alive", 
  6: "Tom Mix", 
  7: "Lucky Seven", 
  8: "Garden Gate", 
  9: "Doctor's Orders", 
  10: "Cameron's Den",
  11: "Legs Eleven", 
  13: "Unlucky for Some",
  16: "Sweet Sixteen",
  21: "Key of the Door",
  22: "Two Little Ducks", 
  30: "Dirty Gertie",
  33: "All the Threes", 
  44: "Droopy Drawers", 
  50: "Half a Century",
  55: "Snakes Alive", 
  66: "Clickety Click", 
  77: "Sunset Strip", 
  88: "Two Fat Ladies", 
  90: "Top of the Shop"
};

export const getNickname = (num: number) => NICKNAMES[num] || `Number ${num}`;

export const WINNING_PATTERNS = [
    { key: 'earlySeven', label: 'Early 7' },
    { key: 'topLine', label: 'Top Line' },
    { key: 'middleLine', label: 'Middle Line' },
    { key: 'bottomLine', label: 'Bottom Line' },
    { key: 'fullHouse', label: 'Full House' },
];