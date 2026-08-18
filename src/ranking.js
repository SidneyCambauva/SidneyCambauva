// Arquivo didatico: calcula a ordem do feed recomendado da SIX.

// Da uma pontuacao para cada publicacao considerando recencia, engajamento, relacao, fixagem e equipe escolar.
export function rankFeedRows(rows) {
  const now = Date.now();

  return rows
    .map((row) => {
      const created = Date.parse(row.createdAt);
      const ageHours = Math.max(1, (now - created) / 36e5);
      const likeCount = row.likeCount ?? row.metrics?.likes ?? 0;
      const replyCount = row.replyCount ?? row.metrics?.replies ?? 0;
      const repostCount = row.repostCount ?? row.metrics?.reposts ?? 0;
      const engagement = likeCount * 4 + replyCount * 5 + repostCount * 6;
      const relationship = row.followsAuthor ? 35 : 0;
      const staffSignal = row.authorRole === 'teacher' ? 6 : 0;
      const freshness = 90 / Math.pow(ageHours + 2, 0.85);
      const ownPostPenalty = row.authorId === row.viewerId ? -4 : 0;

      return {
        ...row,
        score: freshness + engagement + relationship + staffSignal + ownPostPenalty
      };
    })
    .sort((a, b) => {
      const aPinned = Boolean(a.pinnedAt);
      const bPinned = Boolean(b.pinnedAt);
      if (aPinned !== bPinned) return bPinned - aPinned;
      if (aPinned && bPinned) return Date.parse(b.pinnedAt) - Date.parse(a.pinnedAt);
      if (b.score !== a.score) return b.score - a.score;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
}
