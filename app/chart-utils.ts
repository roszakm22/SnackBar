const NICE_FACTORS = [1, 2, 2.5, 5, 10];

export function moneyChartScale(values: number[]) {
  const dataMinimum = Math.min(0, ...values);
  const dataMaximum = Math.max(0, ...values);
  const range = Math.max(dataMaximum - dataMinimum, 1);
  const roughStep = range / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor = NICE_FACTORS.reduce((best, candidate) =>
    Math.abs(candidate - normalized) < Math.abs(best - normalized) ? candidate : best
  );
  const step = factor * magnitude;
  const tickMinimum = Math.floor(dataMinimum / step) * step;
  const tickMaximum = Math.ceil(dataMaximum / step) * step;
  const tickCount = Math.round((tickMaximum - tickMinimum) / step);
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) =>
    Number((tickMinimum + index * step).toPrecision(12))
  );
  const minimum = tickMinimum === 0 ? -step * 0.3 : tickMinimum;
  const maximum = tickMaximum === 0 ? step * 0.3 : tickMaximum;

  return {
    domain: [minimum, maximum] as [number, number],
    ticks,
    zeroOffset: maximum / (maximum - minimum) * 100,
  };
}

export function chartMoney(dollars: number) {
  const rounded = Math.abs(dollars) < 10 ? Math.round(dollars * 100) / 100 : Math.round(dollars);
  return `$${Object.is(rounded, -0) ? 0 : rounded}`;
}
