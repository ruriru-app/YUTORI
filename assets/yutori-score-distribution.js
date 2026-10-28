(function (root) {
  "use strict";

  function buildDistribution(scores, maximum, ownScore = null) {
    const empty = { maximum: null, count: 0, average: null, bins: [], ownScore: null, ownBin: null };
    if (!Number.isFinite(maximum) || maximum <= 0) return empty;

    const validScore = score => Number.isFinite(score) && score >= 0 && score <= maximum;
    const binIndex = score => {
      const position = score / maximum * 10;
      const nearest = Math.round(position);
      // Only correct machine-precision drift at band boundaries (e.g. .42 / .7).
      const adjusted = Math.abs(position - nearest) <= Number.EPSILON * Math.max(1, position) * 4 ? nearest : position;
      return Math.min(9, Math.floor(adjusted));
    };
    const bins = Array.from({ length: 10 }, (_, index) => ({
      from: maximum * (index / 10), to: maximum * ((index + 1) / 10), count: 0
    }));
    const validScores = scores.filter(validScore);
    for (const score of validScores) bins[binIndex(score)].count++;
    const count = validScores.length;
    const hasOwnScore = count > 0 && validScore(ownScore);
    return {
      maximum, count,
      average: count ? validScores.reduce((sum, score) => sum + score, 0) / count : null,
      bins, ownScore: hasOwnScore ? ownScore : null, ownBin: hasOwnScore ? binIndex(ownScore) : null
    };
  }

  root.YutoriScoreDistribution = Object.freeze({ buildDistribution });
})(globalThis);
