const LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 720;
const TAU = Math.PI * 2;
// The authored stick poses are roughly 172 units tall (including the head),
// while combat space uses fighter.height as the authoritative body height.
// Keeping this conversion explicit makes the drawing and combat boxes share
// the same scale instead of rendering a 170px fighter over a 112px hurtbox.
const POSE_REFERENCE_HEIGHT = 172;

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const lerp = (from, to, amount) => from + (to - from) * amount;
const easeOut = (value) => 1 - (1 - value) ** 3;
const easeInOut = (value) => value < 0.5
  ? 4 * value ** 3
  : 1 - ((-2 * value + 2) ** 3) / 2;

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function withAlpha(ctx, alpha, draw) {
  const previous = ctx.globalAlpha;
  ctx.globalAlpha = previous * alpha;
  draw();
  ctx.globalAlpha = previous;
}

function shadeHex(color, amount) {
  if (typeof color !== "string") return "#e9edf5";
  const match = color.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!match) return color;
  let hex = match[1];
  if (hex.length === 3) hex = [...hex].map((part) => part + part).join("");
  const channels = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const target = amount < 0 ? 0 : 255;
  const weight = Math.abs(amount);
  return `rgb(${channels.map((channel) => Math.round(lerp(channel, target, weight))).join(",")})`;
}

function point(x, y) {
  return [x, y];
}

const POSES = {
  idleA: {
    head: point(1, -150), neck: point(0, -119), hip: point(-2, -65),
    backElbow: point(-21, -91), backHand: point(-11, -67),
    frontElbow: point(27, -95), frontHand: point(34, -72),
    backKnee: point(-24, -31), backFoot: point(-35, 0),
    frontKnee: point(22, -34), frontFoot: point(34, 0),
  },
  idleB: {
    head: point(0, -153), neck: point(0, -121), hip: point(-1, -66),
    backElbow: point(-19, -94), backHand: point(-8, -70),
    frontElbow: point(28, -98), frontHand: point(36, -75),
    backKnee: point(-22, -32), backFoot: point(-34, 0),
    frontKnee: point(23, -35), frontFoot: point(35, 0),
  },
  walkA: {
    head: point(7, -148), neck: point(4, -117), hip: point(0, -63),
    backElbow: point(17, -90), backHand: point(31, -69),
    frontElbow: point(-18, -92), frontHand: point(-30, -70),
    backKnee: point(25, -31), backFoot: point(47, -2),
    frontKnee: point(-22, -37), frontFoot: point(-42, 0),
  },
  walkB: {
    head: point(6, -150), neck: point(3, -119), hip: point(0, -64),
    backElbow: point(-19, -92), backHand: point(-30, -70),
    frontElbow: point(23, -91), frontHand: point(38, -70),
    backKnee: point(-24, -34), backFoot: point(-43, -1),
    frontKnee: point(24, -35), frontFoot: point(47, 0),
  },
  crouch: {
    head: point(8, -112), neck: point(3, -83), hip: point(-4, -45),
    backElbow: point(-17, -65), backHand: point(-5, -46),
    frontElbow: point(29, -69), frontHand: point(37, -48),
    backKnee: point(-33, -27), backFoot: point(-51, 0),
    frontKnee: point(28, -21), frontFoot: point(51, 0),
  },
  jump: {
    head: point(3, -151), neck: point(1, -120), hip: point(-1, -69),
    backElbow: point(-28, -105), backHand: point(-34, -80),
    frontElbow: point(31, -105), frontHand: point(41, -82),
    backKnee: point(-29, -40), backFoot: point(-8, -16),
    frontKnee: point(28, -43), frontFoot: point(48, -22),
  },
  lightWindup: {
    head: point(-7, -149), neck: point(-8, -118), hip: point(-10, -65),
    backElbow: point(-35, -91), backHand: point(-47, -67),
    frontElbow: point(-25, -101), frontHand: point(-43, -89),
    backKnee: point(-29, -33), backFoot: point(-43, 0),
    frontKnee: point(20, -34), frontFoot: point(39, 0),
  },
  lightHit: {
    head: point(12, -147), neck: point(9, -116), hip: point(-3, -64),
    backElbow: point(-15, -87), backHand: point(-4, -67),
    frontElbow: point(53, -112), frontHand: point(94, -112),
    backKnee: point(-25, -31), backFoot: point(-40, 0),
    frontKnee: point(27, -33), frontFoot: point(44, 0),
  },
  heavyWindup: {
    head: point(-14, -147), neck: point(-15, -116), hip: point(-10, -63),
    backElbow: point(-44, -112), backHand: point(-34, -139),
    frontElbow: point(-27, -130), frontHand: point(-4, -148),
    backKnee: point(-31, -34), backFoot: point(-50, 0),
    frontKnee: point(17, -31), frontFoot: point(41, 0),
  },
  heavyHit: {
    head: point(17, -142), neck: point(12, -111), hip: point(-1, -62),
    backElbow: point(25, -93), backHand: point(55, -78),
    frontElbow: point(60, -98), frontHand: point(112, -83),
    backKnee: point(-29, -31), backFoot: point(-48, 0),
    frontKnee: point(30, -29), frontFoot: point(52, 0),
  },
  specialWindup: {
    head: point(-6, -148), neck: point(-7, -117), hip: point(-8, -64),
    backElbow: point(-38, -112), backHand: point(-21, -92),
    frontElbow: point(-27, -90), frontHand: point(-6, -82),
    backKnee: point(-28, -33), backFoot: point(-47, 0),
    frontKnee: point(22, -34), frontFoot: point(45, 0),
  },
  specialCast: {
    head: point(9, -147), neck: point(7, -116), hip: point(-2, -64),
    backElbow: point(38, -102), backHand: point(70, -95),
    frontElbow: point(46, -114), frontHand: point(78, -101),
    backKnee: point(-29, -31), backFoot: point(-47, 0),
    frontKnee: point(28, -32), frontFoot: point(51, 0),
  },
  highLightWindup: {
    head: point(-5, -150), neck: point(-6, -119), hip: point(-8, -65),
    backElbow: point(-25, -94), backHand: point(-10, -75),
    frontElbow: point(-24, -122), frontHand: point(-38, -137),
    backKnee: point(-28, -32), backFoot: point(-43, 0),
    frontKnee: point(21, -34), frontFoot: point(41, 0),
  },
  highLightHit: {
    head: point(10, -149), neck: point(8, -118), hip: point(-2, -65),
    backElbow: point(-13, -93), backHand: point(0, -73),
    frontElbow: point(51, -137), frontHand: point(96, -142),
    backKnee: point(-26, -31), backFoot: point(-42, 0),
    frontKnee: point(27, -34), frontFoot: point(45, 0),
  },
  highHeavyWindup: {
    head: point(-19, -143), neck: point(-17, -112), hip: point(-12, -62),
    backElbow: point(-45, -118), backHand: point(-32, -144),
    frontElbow: point(-20, -151), frontHand: point(8, -171),
    backKnee: point(-34, -34), backFoot: point(-54, 0),
    frontKnee: point(18, -29), frontFoot: point(44, 0),
  },
  highHeavyHit: {
    head: point(17, -144), neck: point(12, -112), hip: point(-2, -61),
    backElbow: point(25, -104), backHand: point(51, -119),
    frontElbow: point(58, -151), frontHand: point(105, -150),
    backKnee: point(-31, -31), backFoot: point(-51, 0),
    frontKnee: point(31, -29), frontFoot: point(55, 0),
  },
  midLightWindup: {
    head: point(-4, -148), neck: point(-5, -117), hip: point(-7, -64),
    backElbow: point(-25, -92), backHand: point(-11, -72),
    frontElbow: point(-24, -97), frontHand: point(-42, -91),
    backKnee: point(-27, -32), backFoot: point(-43, 0),
    frontKnee: point(22, -34), frontFoot: point(42, 0),
  },
  midLightHit: {
    head: point(9, -146), neck: point(7, -115), hip: point(-2, -63),
    backElbow: point(-12, -90), backHand: point(1, -70),
    frontElbow: point(49, -99), frontHand: point(91, -94),
    backKnee: point(-26, -31), backFoot: point(-42, 0),
    frontKnee: point(27, -33), frontFoot: point(46, 0),
  },
  midHeavyWindup: {
    head: point(-18, -142), neck: point(-16, -111), hip: point(-12, -61),
    backElbow: point(-43, -91), backHand: point(-52, -67),
    frontElbow: point(-35, -110), frontHand: point(-56, -96),
    backKnee: point(-35, -33), backFoot: point(-55, 0),
    frontKnee: point(18, -29), frontFoot: point(45, 0),
  },
  midHeavyHit: {
    head: point(22, -137), neck: point(17, -106), hip: point(1, -59),
    backElbow: point(39, -91), backHand: point(70, -75),
    frontElbow: point(66, -91), frontHand: point(108, -77),
    backKnee: point(-31, -29), backFoot: point(-52, 0),
    frontKnee: point(34, -27), frontFoot: point(60, 0),
  },
  lowLightWindup: {
    head: point(-4, -124), neck: point(-6, -94), hip: point(-8, -48),
    backElbow: point(-25, -75), backHand: point(-9, -55),
    frontElbow: point(20, -86), frontHand: point(33, -67),
    backKnee: point(-38, -28), backFoot: point(-59, 0),
    frontKnee: point(25, -20), frontFoot: point(48, 0),
  },
  lowLightHit: {
    head: point(-2, -120), neck: point(-4, -90), hip: point(-5, -45),
    backElbow: point(-24, -74), backHand: point(-8, -54),
    frontElbow: point(22, -83), frontHand: point(36, -63),
    backKnee: point(-37, -27), backFoot: point(-58, 0),
    frontKnee: point(49, -31), frontFoot: point(99, -25),
  },
  lowHeavyWindup: {
    head: point(-18, -113), neck: point(-16, -83), hip: point(-10, -42),
    backElbow: point(-39, -75), backHand: point(-50, -52),
    frontElbow: point(13, -76), frontHand: point(28, -58),
    backKnee: point(-47, -25), backFoot: point(-69, 0),
    frontKnee: point(26, -19), frontFoot: point(52, 0),
  },
  lowHeavyHit: {
    head: point(-11, -105), neck: point(-9, -76), hip: point(-4, -38),
    backElbow: point(-34, -67), backHand: point(-46, -44),
    frontElbow: point(18, -69), frontHand: point(34, -51),
    backKnee: point(-42, -23), backFoot: point(-66, 0),
    frontKnee: point(62, -13), frontFoot: point(108, -4),
  },
  throwReach: {
    head: point(12, -143), neck: point(9, -112), hip: point(-2, -61),
    backElbow: point(42, -105), backHand: point(78, -99),
    frontElbow: point(45, -91), frontHand: point(81, -87),
    backKnee: point(-29, -31), backFoot: point(-49, 0),
    frontKnee: point(30, -29), frontFoot: point(55, 0),
  },
  throwLift: {
    head: point(-7, -138), neck: point(-7, -107), hip: point(-6, -57),
    backElbow: point(30, -133), backHand: point(56, -159),
    frontElbow: point(48, -119), frontHand: point(75, -144),
    backKnee: point(-42, -28), backFoot: point(-67, 0),
    frontKnee: point(31, -25), frontFoot: point(61, 0),
  },
  throwSlam: {
    head: point(14, -105), neck: point(11, -76), hip: point(-3, -39),
    backElbow: point(45, -54), backHand: point(79, -28),
    frontElbow: point(56, -42), frontHand: point(91, -14),
    backKnee: point(-44, -24), backFoot: point(-72, 0),
    frontKnee: point(38, -18), frontFoot: point(73, 0),
  },
  throwWhiff: {
    head: point(25, -132), neck: point(20, -101), hip: point(7, -54),
    backElbow: point(61, -98), backHand: point(101, -91),
    frontElbow: point(65, -81), frontHand: point(107, -72),
    backKnee: point(-19, -28), backFoot: point(-42, 0),
    frontKnee: point(45, -22), frontFoot: point(74, 0),
  },
  fireballLightCharge: {
    head: point(-9, -145), neck: point(-9, -114), hip: point(-8, -62),
    backElbow: point(-34, -105), backHand: point(-11, -91),
    frontElbow: point(-26, -84), frontHand: point(-3, -88),
    backKnee: point(-32, -32), backFoot: point(-51, 0),
    frontKnee: point(23, -31), frontFoot: point(48, 0),
  },
  fireballLightCast: {
    head: point(10, -144), neck: point(8, -113), hip: point(-2, -61),
    backElbow: point(40, -105), backHand: point(75, -98),
    frontElbow: point(44, -88), frontHand: point(78, -94),
    backKnee: point(-30, -30), backFoot: point(-50, 0),
    frontKnee: point(30, -29), frontFoot: point(55, 0),
  },
  fireballHeavyCharge: {
    head: point(-20, -120), neck: point(-18, -90), hip: point(-13, -46),
    backElbow: point(-48, -90), backHand: point(-24, -71),
    frontElbow: point(-40, -65), frontHand: point(-15, -68),
    backKnee: point(-46, -27), backFoot: point(-70, 0),
    frontKnee: point(29, -22), frontFoot: point(59, 0),
  },
  fireballHeavyCast: {
    head: point(22, -130), neck: point(17, -99), hip: point(0, -52),
    backElbow: point(55, -102), backHand: point(96, -91),
    frontElbow: point(65, -77), frontHand: point(106, -88),
    backKnee: point(-41, -27), backFoot: point(-68, 0),
    frontKnee: point(40, -24), frontFoot: point(72, 0),
  },
  dragonCoil: {
    head: point(-7, -107), neck: point(-9, -77), hip: point(-9, -37),
    backElbow: point(-31, -70), backHand: point(-13, -54),
    frontElbow: point(16, -61), frontHand: point(4, -38),
    backKnee: point(-43, -23), backFoot: point(-67, 0),
    frontKnee: point(27, -17), frontFoot: point(58, 0),
  },
  dragonRise: {
    head: point(4, -171), neck: point(2, -140), hip: point(-6, -87),
    backElbow: point(-25, -123), backHand: point(-18, -98),
    frontElbow: point(27, -184), frontHand: point(40, -224),
    backKnee: point(-30, -59), backFoot: point(-8, -34),
    frontKnee: point(28, -56), frontFoot: point(48, -32),
  },
  dragonRecover: {
    head: point(10, -151), neck: point(6, -120), hip: point(-2, -69),
    backElbow: point(-26, -108), backHand: point(-35, -84),
    frontElbow: point(35, -120), frontHand: point(51, -97),
    backKnee: point(-30, -42), backFoot: point(-10, -18),
    frontKnee: point(30, -45), frontFoot: point(50, -23),
  },
  airLightWindup: {
    head: point(-7, -149), neck: point(-7, -118), hip: point(-4, -68),
    backElbow: point(-28, -105), backHand: point(-20, -81),
    frontElbow: point(-26, -112), frontHand: point(-44, -104),
    backKnee: point(-31, -48), backFoot: point(-9, -23),
    frontKnee: point(28, -47), frontFoot: point(48, -23),
  },
  airLightHit: {
    head: point(10, -148), neck: point(8, -117), hip: point(-1, -67),
    backElbow: point(-17, -101), backHand: point(-8, -78),
    frontElbow: point(50, -113), frontHand: point(96, -112),
    backKnee: point(-31, -47), backFoot: point(-8, -22),
    frontKnee: point(30, -45), frontFoot: point(50, -21),
  },
  airHeavyWindup: {
    head: point(-13, -148), neck: point(-12, -117), hip: point(-7, -67),
    backElbow: point(-38, -108), backHand: point(-45, -84),
    frontElbow: point(15, -130), frontHand: point(27, -108),
    backKnee: point(-34, -48), backFoot: point(-12, -20),
    frontKnee: point(13, -43), frontFoot: point(-3, -20),
  },
  airHeavyKick: {
    head: point(-13, -140), neck: point(-10, -109), hip: point(1, -64),
    backElbow: point(-34, -105), backHand: point(-43, -82),
    frontElbow: point(18, -121), frontHand: point(31, -101),
    backKnee: point(-34, -45), backFoot: point(-11, -20),
    frontKnee: point(50, -42), frontFoot: point(109, -14),
  },
  airTatsuWindup: {
    head: point(-7, -143), neck: point(-8, -112), hip: point(-4, -65),
    backElbow: point(-33, -106), backHand: point(-39, -83),
    frontElbow: point(24, -108), frontHand: point(38, -87),
    backKnee: point(-35, -46), backFoot: point(-12, -20),
    frontKnee: point(30, -45), frontFoot: point(50, -23),
  },
  airTatsuSpin: {
    head: point(-57, -95), neck: point(-32, -86), hip: point(15, -72),
    backElbow: point(-12, -116), backHand: point(14, -116),
    frontElbow: point(-14, -58), frontHand: point(11, -47),
    backKnee: point(45, -101), backFoot: point(73, -112),
    frontKnee: point(64, -71), frontFoot: point(108, -70),
  },
  airHammerWindup: {
    head: point(-1, -157), neck: point(-2, -126), hip: point(-2, -72),
    backElbow: point(-27, -143), backHand: point(-8, -168),
    frontElbow: point(24, -148), frontHand: point(8, -174),
    backKnee: point(-31, -49), backFoot: point(-9, -22),
    frontKnee: point(29, -48), frontFoot: point(49, -23),
  },
  airHammerDrop: {
    head: point(9, -133), neck: point(6, -102), hip: point(0, -64),
    backElbow: point(18, -78), backHand: point(34, -39),
    frontElbow: point(37, -76), frontHand: point(51, -32),
    backKnee: point(-34, -45), backFoot: point(-11, -18),
    frontKnee: point(31, -43), frontFoot: point(52, -18),
  },
  rekkaLightWindup: {
    head: point(-12, -146), neck: point(-12, -115), hip: point(-9, -63),
    backElbow: point(-38, -103), backHand: point(-46, -79),
    frontElbow: point(-29, -98), frontHand: point(-48, -88),
    backKnee: point(-37, -31), backFoot: point(-59, 0),
    frontKnee: point(24, -30), frontFoot: point(50, 0),
  },
  rekkaLightHit: {
    head: point(19, -140), neck: point(15, -109), hip: point(6, -59),
    backElbow: point(18, -91), backHand: point(43, -77),
    frontElbow: point(63, -102), frontHand: point(109, -91),
    backKnee: point(-32, -28), backFoot: point(-57, 0),
    frontKnee: point(43, -25), frontFoot: point(78, 0),
  },
  rekkaHeavyWindup: {
    head: point(-21, -139), neck: point(-19, -108), hip: point(-13, -58),
    backElbow: point(-48, -112), backHand: point(-38, -138),
    frontElbow: point(-43, -85), frontHand: point(-62, -67),
    backKnee: point(-44, -31), backFoot: point(-70, 0),
    frontKnee: point(21, -26), frontFoot: point(52, 0),
  },
  rekkaHeavyDrive: {
    head: point(24, -137), neck: point(19, -106), hip: point(8, -56),
    backElbow: point(36, -105), backHand: point(70, -115),
    frontElbow: point(65, -91), frontHand: point(108, -78),
    backKnee: point(-36, -27), backFoot: point(-63, 0),
    frontKnee: point(48, -23), frontFoot: point(86, 0),
  },
  rekkaHeavyFinish: {
    head: point(31, -128), neck: point(25, -97), hip: point(11, -52),
    backElbow: point(55, -95), backHand: point(91, -76),
    frontElbow: point(78, -73), frontHand: point(108, -51),
    backKnee: point(-34, -25), backFoot: point(-62, 0),
    frontKnee: point(55, -21), frontFoot: point(96, 0),
  },
  block: {
    head: point(-7, -143), neck: point(-8, -112), hip: point(-9, -61),
    backElbow: point(15, -111), backHand: point(4, -135),
    frontElbow: point(29, -93), frontHand: point(13, -117),
    backKnee: point(-31, -31), backFoot: point(-50, 0),
    frontKnee: point(25, -29), frontFoot: point(48, 0),
  },
  hit: {
    head: point(-23, -145), neck: point(-17, -113), hip: point(-8, -61),
    backElbow: point(-42, -104), backHand: point(-53, -82),
    frontElbow: point(-9, -83), frontHand: point(-24, -61),
    backKnee: point(-33, -31), backFoot: point(-53, 0),
    frontKnee: point(20, -29), frontFoot: point(44, 0),
  },
  knockdown: {
    head: point(-60, -57), neck: point(-34, -47), hip: point(12, -28),
    backElbow: point(-22, -69), backHand: point(-1, -76),
    frontElbow: point(-23, -30), frontHand: point(-45, -13),
    backKnee: point(38, -31), backFoot: point(65, -9),
    frontKnee: point(37, -12), frontFoot: point(70, -1),
  },
  ko: {
    head: point(-73, -27), neck: point(-46, -24), hip: point(0, -20),
    backElbow: point(-29, -42), backHand: point(-8, -52),
    frontElbow: point(-32, -11), frontHand: point(-58, -2),
    backKnee: point(37, -30), backFoot: point(72, -17),
    frontKnee: point(40, -12), frontFoot: point(79, -1),
  },
};

// Yakumo is authored as a 13-impact cinematic.  Keep its visual choreography
// keyed to the move's real hit frames so the renderer cannot collapse the
// climax back into one generic rekka pose when the frame data is retuned.
const YAKUMO_HIT_COUNT = 13;
const YAKUMO_IMPACT_POSES = [
  POSES.midLightHit,
  POSES.highHeavyHit,
  POSES.lowLightHit,
  POSES.rekkaLightHit,
  POSES.dragonRise,
  POSES.airTatsuSpin,
  POSES.midHeavyHit,
  POSES.lowHeavyHit,
  POSES.highLightHit,
  POSES.fireballHeavyCast,
  POSES.airHeavyKick,
  POSES.rekkaHeavyDrive,
  POSES.rekkaHeavyFinish,
];
const YAKUMO_BRIDGE_POSES = [
  POSES.highHeavyWindup,
  POSES.lowLightWindup,
  POSES.rekkaLightWindup,
  POSES.dragonCoil,
  POSES.airTatsuWindup,
  POSES.midHeavyWindup,
  POSES.lowHeavyWindup,
  POSES.highLightWindup,
  POSES.fireballHeavyCharge,
  POSES.airHeavyWindup,
  POSES.rekkaHeavyWindup,
  POSES.heavyWindup,
  POSES.specialWindup,
];
const YAKUMO_LUNGES = [10, 25, 13, 33, 22, 43, 34, 49, 38, 54, 47, 63, 78];
const YAKUMO_LIFTS = [0, 0, 0, 2, 62, 43, 4, 0, 0, 4, 24, 8, 0];
const YAKUMO_SLASH_ANGLES = [-0.22, -1.4, 0.7, -0.5, -1.72, 0.2, -0.32, 0.88, -1.1, -0.62, 0.34, -0.45, -0.18];

function yakumoHitFrames(fighter) {
  const move = fighter?.currentMove ?? fighter?.moveData ?? fighter?.move ?? {};
  const authored = Array.isArray(move?.hits)
    ? move.hits.slice(0, YAKUMO_HIT_COUNT).map((hit) => Number(hit?.start))
    : [];
  const valid = authored.length === YAKUMO_HIT_COUNT && authored.every(Number.isFinite);
  if (valid && new Set(authored).size >= YAKUMO_HIT_COUNT - 1) return authored;

  // Legacy/sparse data fallback: spread the visual beats over the active span.
  // Proper frame data always takes the branch above; this merely prevents an
  // older replay from displaying all thirteen poses on the same canvas frame.
  const startup = Math.max(1, Number(move?.startup) || 11);
  const activeEnd = Array.isArray(move?.activeWindows) && move.activeWindows.length > 0
    ? Math.max(...move.activeWindows.map((window) => Number(window?.end) || startup))
    : Math.max(startup + 24, (Number(fighter?.actionDuration) || 76) - (Number(move?.recovery) || 45));
  const spacing = Math.max(2, Math.floor(Math.max(24, activeEnd - startup) / (YAKUMO_HIT_COUNT - 1)));
  return Array.from({ length: YAKUMO_HIT_COUNT }, (_, index) => startup + index * spacing);
}

function yakumoVisualState(fighter) {
  const moveId = String(fighter?.currentMoveId ?? fighter?.currentMove?.id ?? "").toLowerCase();
  if (moveId !== "yakumo") return null;

  const frame = Math.max(1, (Number(fighter?.actionFrame) || 0) + 1);
  const frames = yakumoHitFrames(fighter);
  const first = frames[0];
  const last = frames[frames.length - 1];
  const duration = Math.max(last + 1, Number(fighter?.actionDuration) || last + 30);

  if (frame < first) {
    return {
      phase: "startup",
      progress: clamp((frame - 1) / Math.max(1, first - 1)),
      hitIndex: -1,
      localProgress: 0,
      impactPulse: 0,
      lunge: 0,
      lift: 0,
      frame,
    };
  }

  if (frame > last + 1) {
    return {
      phase: "recovery",
      progress: clamp((frame - last - 1) / Math.max(1, duration - last - 1)),
      hitIndex: YAKUMO_HIT_COUNT - 1,
      localProgress: 1,
      impactPulse: 0,
      lunge: lerp(YAKUMO_LUNGES[YAKUMO_HIT_COUNT - 1], 0, clamp((frame - last) / 13)),
      lift: 0,
      frame,
    };
  }

  let hitIndex = 0;
  for (let index = 1; index < frames.length; index += 1) {
    if (frame >= frames[index]) hitIndex = index;
    else break;
  }
  const currentFrame = frames[hitIndex];
  const nextFrame = frames[Math.min(hitIndex + 1, frames.length - 1)];
  const interval = Math.max(1, nextFrame - currentFrame);
  const localProgress = hitIndex === frames.length - 1 ? 0 : clamp((frame - currentFrame) / interval);
  const impactDistance = Math.min(...frames.map((hitFrame) => Math.abs(frame - hitFrame)));
  const impactPulse = clamp(1 - impactDistance / 2.25);

  return {
    phase: "strikes",
    progress: clamp((frame - first) / Math.max(1, last - first)),
    hitIndex,
    localProgress,
    impactPulse,
    lunge: YAKUMO_LUNGES[hitIndex],
    lift: YAKUMO_LIFTS[hitIndex],
    frame,
  };
}

function yakumoPoseFor(state) {
  if (state.phase === "startup") {
    return sampleTimeline([
      [0, POSES.idleA],
      [0.48, POSES.specialWindup],
      [0.78, POSES.heavyWindup, easeOut],
      [1, POSES.midLightWindup],
    ], state.progress);
  }
  if (state.phase === "recovery") {
    return sampleTimeline([
      [0, YAKUMO_IMPACT_POSES[YAKUMO_HIT_COUNT - 1]],
      [0.34, POSES.throwSlam],
      [0.7, POSES.specialCast],
      [1, POSES.idleA],
    ], state.progress);
  }

  const index = state.hitIndex;
  const current = YAKUMO_IMPACT_POSES[index];
  if (index >= YAKUMO_HIT_COUNT - 1) return current;
  const bridge = YAKUMO_BRIDGE_POSES[index];
  const next = YAKUMO_IMPACT_POSES[index + 1];
  if (state.localProgress <= 0.22) return current;
  if (state.localProgress <= 0.62) {
    return mixPose(current, bridge, easeInOut((state.localProgress - 0.22) / 0.4));
  }
  return mixPose(bridge, next, easeOut((state.localProgress - 0.62) / 0.38));
}

function mixPose(from, to, amount) {
  const result = {};
  for (const key of Object.keys(from)) {
    result[key] = [
      lerp(from[key][0], to[key][0], amount),
      lerp(from[key][1], to[key][1], amount),
    ];
  }
  return result;
}

function sampleTimeline(timeline, progress) {
  const value = clamp(progress);
  for (let index = 1; index < timeline.length; index += 1) {
    const [time, pose, easing = easeInOut] = timeline[index];
    const [previousTime, previousPose] = timeline[index - 1];
    if (value <= time) {
      const local = clamp((value - previousTime) / Math.max(0.0001, time - previousTime));
      return mixPose(previousPose, pose, easing(local));
    }
  }
  return timeline[timeline.length - 1][1];
}

function normalizeAction(value) {
  const action = String(value ?? "idle").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (action.includes("knockout") || action === "ko" || action.includes("dead")) return "ko";
  if (action.includes("knock") || action.includes("down") || action.includes("fall")) return "knockdown";
  if (action.includes("hurt") || action.includes("hitstun") || action.includes("stagger") || action === "hit") return "hit";
  if (action.includes("block") || action.includes("guard") || action.includes("parry")) return "block";
  if (action.includes("airlight") || action.includes("aeriallight") || action.includes("jumplightpunch")) return "airLight";
  if (action.includes("airheavy") || action.includes("aerialheavy") || action.includes("jumpheavykick")) return "airHeavy";
  if (action.includes("airtatsu") || action.includes("tatsuair") || action.includes("aerialtatsu")) return "airTatsu";
  if (action.includes("airhammer") || action.includes("hammerair") || action.includes("aerialhammer")) return "airHammer";
  if (action.includes("rekkaheavy") || action.includes("heavyrekka")) return "rekkaHeavy";
  if (action.includes("rekkalight") || action.includes("lightrekka")) return "rekkaLight";
  if (action.includes("throwwhiff") || action.includes("throwmiss") || action.includes("grabwhiff") || action.includes("grabmiss")) return "throwWhiff";
  if (action.includes("throw") || action.includes("grab")) return "throw";
  if (action.includes("dragonpunch") || action.includes("uppercut") || action.includes("shoryu") || action === "dp") return "dragonPunch";
  if (action.includes("fireballheavy") || action.includes("heavyfireball") || action.includes("hadokenheavy")) return "fireballHeavy";
  if (action.includes("fireballlight") || action.includes("lightfireball") || action.includes("hadokenlight")) return "fireballLight";
  if (action.includes("highheavy") || action.includes("heavyhigh")) return "highHeavy";
  if (action.includes("highlight") || action.includes("lighthigh")) return "highLight";
  if (action.includes("midheavy") || action.includes("heavymid") || action.includes("middleheavy")) return "midHeavy";
  if (action.includes("midlight") || action.includes("lightmid") || action.includes("middlelight")) return "midLight";
  if (action.includes("lowheavy") || action.includes("heavylow") || action.includes("sweep")) return "lowHeavy";
  if (action.includes("lowlight") || action.includes("lightlow") || action.includes("lowpoke")) return "lowLight";
  if (action.includes("special") || action.includes("fireball") || action.includes("projectile") || action.includes("skill")) return "special";
  if (action.includes("heavy") || action.includes("strong")) return "heavy";
  if (action.includes("light") || action.includes("jab") || action.includes("punch") || action.includes("kick") || action.includes("attack")) return "light";
  if (action.includes("crouch") || action.includes("duck")) return "crouch";
  if (action.includes("jump") || action.includes("air") || action.includes("fall")) return "jump";
  if (action.includes("walk") || action.includes("run") || action.includes("move") || action.includes("dash")) return "walk";
  return "idle";
}

function animationActionFor(fighter) {
  const move = fighter?.currentMove ?? fighter?.moveData ?? fighter?.move;
  return fighter?.moveAnimation
    ?? fighter?.animationAction
    ?? move?.moveAnimation
    ?? move?.animationAction
    ?? fighter?.action;
}

function inclusiveProgress(frame, start, end, singleFrameValue = 1) {
  if (end <= start) return singleFrameValue;
  return clamp((frame - start) / (end - start));
}

function authoredMoveClock(fighter) {
  const move = fighter?.currentMove ?? fighter?.moveData ?? fighter?.move;
  const windows = Array.isArray(move?.activeWindows)
    ? move.activeWindows
      .map((window, index) => ({
        index,
        start: Number(window?.start),
        end: Number(window?.end),
      }))
      .filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end))
      .sort((a, b) => a.start - b.start || a.end - b.end)
    : [];
  if (!move || windows.length === 0) return null;

  const frame = Math.max(1, (Number(fighter?.actionFrame) || 0) + 1);
  const firstActive = windows[0].start;
  const lastActive = Math.max(...windows.map((window) => window.end));
  const totalFrames = Math.max(lastActive, Number(move?.totalFrames) || Number(fighter?.actionDuration) || lastActive);
  const activeWindowIndex = windows.findIndex((window) => frame >= window.start && frame <= window.end);

  if (frame < firstActive) {
    return {
      phase: "startup",
      progress: inclusiveProgress(frame, 1, firstActive - 1),
      frame,
      firstActive,
      lastActive,
      totalFrames,
      activeWindowIndex: -1,
      activeProgress: 0,
      windows,
    };
  }

  if (activeWindowIndex >= 0) {
    const window = windows[activeWindowIndex];
    return {
      phase: "active",
      progress: inclusiveProgress(frame, window.start, window.end),
      frame,
      firstActive,
      lastActive,
      totalFrames,
      activeWindowIndex,
      activeProgress: clamp((frame - firstActive) / Math.max(1, lastActive - firstActive)),
      windows,
    };
  }

  if (frame <= lastActive) {
    const previous = [...windows].reverse().find((window) => window.end < frame) ?? windows[0];
    const next = windows.find((window) => window.start > frame) ?? windows[windows.length - 1];
    return {
      phase: "gap",
      progress: inclusiveProgress(frame, previous.end + 1, next.start - 1, 0.5),
      frame,
      firstActive,
      lastActive,
      totalFrames,
      activeWindowIndex: previous.index,
      nextActiveWindowIndex: next.index,
      activeProgress: clamp((frame - firstActive) / Math.max(1, lastActive - firstActive)),
      windows,
    };
  }

  return {
    phase: "recovery",
    progress: inclusiveProgress(frame, lastActive + 1, totalFrames),
    frame,
    firstActive,
    lastActive,
    totalFrames,
    activeWindowIndex: windows[windows.length - 1].index,
    activeProgress: 1,
    windows,
  };
}

/**
 * Public, renderer-independent view of the pose clock. Tests and debug tools
 * can use this to verify that anticipation/contact/recovery are keyed to the
 * exact same authored frame as combat.
 */
export function getFighterVisualState(fighter) {
  const action = normalizeAction(animationActionFor(fighter));
  const clock = authoredMoveClock(fighter);
  if (clock) return { action, ...clock };
  const duration = Math.max(1, Number(fighter?.actionDuration) || ACTION_DURATIONS[action] || 20);
  return {
    action,
    phase: fighter?.movePhase ?? action,
    progress: clamp((Number(fighter?.actionFrame) || 0) / duration),
    frame: Math.max(0, Number(fighter?.actionFrame) || 0),
    firstActive: null,
    lastActive: null,
    totalFrames: duration,
    activeWindowIndex: -1,
    activeProgress: 0,
    windows: [],
  };
}

function attackPoseDefinition(action) {
  switch (action) {
    case "airLight":
      return { rest: POSES.jump, windup: POSES.airLightWindup, active: [POSES.airLightHit], recovery: [POSES.airLightHit, POSES.jump] };
    case "airHeavy":
      return { rest: POSES.jump, windup: POSES.airHeavyWindup, active: [POSES.airHeavyKick], recovery: [POSES.airHeavyKick, POSES.jump] };
    case "airTatsu":
      return { rest: POSES.jump, windup: POSES.airTatsuWindup, active: [POSES.airTatsuSpin], recovery: [POSES.airTatsuSpin, POSES.jump] };
    case "airHammer":
      return { rest: POSES.jump, windup: POSES.airHammerWindup, active: [POSES.airHammerDrop], recovery: [POSES.airHammerDrop, POSES.jump] };
    case "rekkaLight":
      return { rest: POSES.idleA, windup: POSES.rekkaLightWindup, active: [POSES.rekkaLightHit], recovery: [POSES.rekkaLightHit, POSES.idleA] };
    case "rekkaHeavy":
      return {
        rest: POSES.idleA,
        windup: POSES.rekkaHeavyWindup,
        active: [POSES.rekkaHeavyDrive, POSES.rekkaHeavyFinish],
        recovery: [POSES.rekkaHeavyFinish, POSES.rekkaHeavyDrive, POSES.idleA],
      };
    case "highLight":
      return { rest: POSES.idleA, windup: POSES.highLightWindup, active: [POSES.highLightHit], recovery: [POSES.highLightHit, POSES.idleA] };
    case "highHeavy":
      return { rest: POSES.idleA, windup: POSES.highHeavyWindup, active: [POSES.highHeavyHit], recovery: [POSES.highHeavyHit, POSES.idleA] };
    case "midLight":
      return { rest: POSES.idleA, windup: POSES.midLightWindup, active: [POSES.midLightHit], recovery: [POSES.midLightHit, POSES.idleA] };
    case "midHeavy":
      return { rest: POSES.idleA, windup: POSES.midHeavyWindup, active: [POSES.midHeavyHit], recovery: [POSES.midHeavyHit, POSES.idleA] };
    case "lowLight":
      return { rest: POSES.crouch, windup: POSES.lowLightWindup, active: [POSES.lowLightHit], recovery: [POSES.lowLightHit, POSES.crouch] };
    case "lowHeavy":
      return { rest: POSES.crouch, windup: POSES.lowHeavyWindup, active: [POSES.lowHeavyHit], recovery: [POSES.lowHeavyHit, POSES.crouch] };
    case "throw":
      return {
        rest: POSES.idleA,
        windup: POSES.throwReach,
        active: [POSES.throwReach],
        recovery: [POSES.throwReach, POSES.throwLift, POSES.throwSlam, POSES.idleA],
      };
    case "throwWhiff":
      return { rest: POSES.idleA, windup: POSES.throwReach, active: [POSES.throwReach], recovery: [POSES.throwReach, POSES.throwWhiff, POSES.idleA] };
    case "fireballLight":
      return { rest: POSES.idleA, windup: POSES.fireballLightCharge, active: [POSES.fireballLightCast], recovery: [POSES.fireballLightCast, POSES.idleA] };
    case "fireballHeavy":
      return { rest: POSES.crouch, windup: POSES.fireballHeavyCharge, active: [POSES.fireballHeavyCast], recovery: [POSES.fireballHeavyCast, POSES.crouch] };
    case "dragonPunch":
      return { rest: POSES.idleA, windup: POSES.dragonCoil, active: [POSES.dragonRise], recovery: [POSES.dragonRise, POSES.dragonRecover, POSES.idleA] };
    case "light":
      return { rest: POSES.idleA, windup: POSES.lightWindup, active: [POSES.lightHit], recovery: [POSES.lightHit, POSES.idleA] };
    case "heavy":
      return { rest: POSES.idleA, windup: POSES.heavyWindup, active: [POSES.heavyHit], recovery: [POSES.heavyHit, POSES.idleA] };
    case "special":
      return { rest: POSES.idleA, windup: POSES.specialWindup, active: [POSES.specialCast], recovery: [POSES.specialCast, POSES.idleA] };
    default:
      return null;
  }
}

function poseFromSequence(sequence, progress) {
  if (!Array.isArray(sequence) || sequence.length === 0) return POSES.idleA;
  if (sequence.length === 1) return sequence[0];
  return sampleTimeline(
    sequence.map((pose, index) => [index / (sequence.length - 1), pose]),
    progress,
  );
}

function authoredAttackPose(fighter, action) {
  const clock = authoredMoveClock(fighter);
  const definition = attackPoseDefinition(action);
  if (!clock || !definition) return null;

  if (clock.phase === "startup") {
    return sampleTimeline([
      [0, definition.rest],
      [0.7, definition.windup, easeInOut],
      [1, definition.windup],
    ], clock.progress);
  }

  if (clock.phase === "active") {
    return poseFromSequence(definition.active, clock.activeProgress);
  }

  if (clock.phase === "gap") {
    const previousPose = poseFromSequence(
      definition.active,
      clamp(clock.activeWindowIndex / Math.max(1, clock.windows.length - 1)),
    );
    const nextPose = poseFromSequence(
      definition.active,
      clamp((clock.nextActiveWindowIndex ?? clock.activeWindowIndex) / Math.max(1, clock.windows.length - 1)),
    );
    return sampleTimeline([
      [0, previousPose],
      [0.5, definition.windup, easeInOut],
      [1, nextPose, easeOut],
    ], clock.progress);
  }

  return poseFromSequence(definition.recovery, clock.progress);
}

function strikeJointFor(action) {
  if (["lowLight", "lowHeavy", "airHeavy", "airTatsu"].includes(action)) return "frontFoot";
  return "frontHand";
}

/**
 * Returns the actual stick pose in combat/world coordinates. Besides making
 * visual regressions testable, this is useful to frame-data tools that need to
 * explain why a particular hitbox sits where it does.
 */
export function getFighterVisualPose(fighter) {
  const state = getFighterVisualState(fighter);
  const pose = poseFor(fighter);
  const scale = Math.max(1, Number(fighter?.height) || 112) / POSE_REFERENCE_HEIGHT;
  const facing = facingSign(fighter?.facing, 1);
  const originX = Number(fighter?.x) || 0;
  const originY = Number(fighter?.y) || 0;
  const joints = Object.fromEntries(
    Object.entries(pose).map(([key, value]) => [
      key,
      [
        originX + facing * value[0] * scale,
        originY + value[1] * scale,
      ],
    ]),
  );
  const points = Object.values(joints);
  const headRadius = 24 * scale;
  const strikeJoint = strikeJointFor(state.action);
  return {
    ...state,
    scale,
    origin: [originX, originY],
    joints,
    headRadius,
    strikeJoint,
    strikePoint: joints[strikeJoint],
    bounds: {
      left: Math.min(...points.map((value) => value[0]), joints.head[0] - headRadius),
      right: Math.max(...points.map((value) => value[0]), joints.head[0] + headRadius),
      top: Math.min(...points.map((value) => value[1]), joints.head[1] - headRadius),
      bottom: Math.max(...points.map((value) => value[1]), joints.head[1] + headRadius),
    },
  };
}

const ACTION_DURATIONS = {
  light: 18,
  heavy: 30,
  special: 42,
  highLight: 15,
  highHeavy: 30,
  midLight: 14,
  midHeavy: 31,
  lowLight: 18,
  lowHeavy: 34,
  throw: 36,
  throwWhiff: 27,
  fireballLight: 34,
  fireballHeavy: 48,
  dragonPunch: 38,
  airLight: 15,
  airHeavy: 29,
  airTatsu: 34,
  airHammer: 31,
  rekkaLight: 21,
  rekkaHeavy: 37,
  hit: 16,
  knockdown: 34,
  ko: 42,
  block: 14,
};

function poseFor(fighter, yakumoState = yakumoVisualState(fighter)) {
  if (yakumoState) return yakumoPoseFor(yakumoState);
  const action = normalizeAction(animationActionFor(fighter));
  const authoredPose = authoredAttackPose(fighter, action);
  if (authoredPose) return authoredPose;
  const frame = Number.isFinite(fighter?.actionFrame) ? fighter.actionFrame : 0;
  if (action === "idle") {
    return mixPose(POSES.idleA, POSES.idleB, 0.5 + Math.sin(frame * 0.12) * 0.5);
  }
  if (action === "walk") {
    return mixPose(POSES.walkA, POSES.walkB, 0.5 + Math.sin(frame * 0.46) * 0.5);
  }
  if (action === "crouch") return POSES.crouch;
  if (action === "jump") {
    return mixPose(POSES.jump, POSES.idleA, 0.08 + Math.sin(frame * 0.18) * 0.03);
  }

  const authoredDuration = Number(fighter?.actionDuration);
  const duration = authoredDuration > 0 ? authoredDuration : (ACTION_DURATIONS[action] ?? 20);
  const progress = clamp(frame / duration);
  switch (action) {
    case "airLight":
      return sampleTimeline([
        [0, POSES.jump], [0.18, POSES.airLightWindup], [0.34, POSES.airLightHit, easeOut],
        [0.51, POSES.airLightHit], [1, POSES.jump],
      ], progress);
    case "airHeavy":
      return sampleTimeline([
        [0, POSES.jump], [0.31, POSES.airHeavyWindup], [0.53, POSES.airHeavyKick, easeOut],
        [0.76, POSES.airHeavyKick], [1, POSES.jump],
      ], progress);
    case "airTatsu":
      return sampleTimeline([
        [0, POSES.jump], [0.24, POSES.airTatsuWindup], [0.43, POSES.airTatsuSpin, easeOut],
        [0.76, POSES.airTatsuSpin], [1, POSES.jump],
      ], progress);
    case "airHammer":
      return sampleTimeline([
        [0, POSES.jump], [0.32, POSES.airHammerWindup], [0.55, POSES.airHammerDrop, easeOut],
        [0.79, POSES.airHammerDrop], [1, POSES.jump],
      ], progress);
    case "rekkaLight":
      return sampleTimeline([
        [0, POSES.idleA], [0.24, POSES.rekkaLightWindup], [0.43, POSES.rekkaLightHit, easeOut],
        [0.62, POSES.rekkaLightHit], [1, POSES.idleA],
      ], progress);
    case "rekkaHeavy":
      return sampleTimeline([
        [0, POSES.idleA], [0.32, POSES.rekkaHeavyWindup], [0.51, POSES.rekkaHeavyDrive, easeOut],
        [0.66, POSES.rekkaHeavyDrive], [0.78, POSES.rekkaHeavyFinish, easeOut],
        [0.9, POSES.rekkaHeavyFinish], [1, POSES.idleA],
      ], progress);
    case "highLight":
      return sampleTimeline([
        [0, POSES.idleA], [0.2, POSES.highLightWindup], [0.36, POSES.highLightHit, easeOut],
        [0.53, POSES.highLightHit], [1, POSES.idleA],
      ], progress);
    case "highHeavy":
      return sampleTimeline([
        [0, POSES.idleA], [0.36, POSES.highHeavyWindup], [0.58, POSES.highHeavyHit, easeOut],
        [0.76, POSES.highHeavyHit], [1, POSES.idleA],
      ], progress);
    case "midLight":
      return sampleTimeline([
        [0, POSES.idleA], [0.2, POSES.midLightWindup], [0.36, POSES.midLightHit, easeOut],
        [0.52, POSES.midLightHit], [1, POSES.idleA],
      ], progress);
    case "midHeavy":
      return sampleTimeline([
        [0, POSES.idleA], [0.36, POSES.midHeavyWindup], [0.57, POSES.midHeavyHit, easeOut],
        [0.76, POSES.midHeavyHit], [1, POSES.idleA],
      ], progress);
    case "lowLight":
      return sampleTimeline([
        [0, POSES.idleA], [0.25, POSES.lowLightWindup], [0.42, POSES.lowLightHit, easeOut],
        [0.58, POSES.lowLightHit], [1, POSES.idleA],
      ], progress);
    case "lowHeavy":
      return sampleTimeline([
        [0, POSES.idleA], [0.36, POSES.lowHeavyWindup], [0.58, POSES.lowHeavyHit, easeOut],
        [0.79, POSES.lowHeavyHit], [1, POSES.idleA],
      ], progress);
    case "throw":
      return sampleTimeline([
        [0, POSES.idleA], [0.24, POSES.throwReach, easeOut], [0.42, POSES.throwReach],
        [0.58, POSES.throwLift], [0.76, POSES.throwSlam, easeOut], [0.9, POSES.throwSlam],
        [1, POSES.idleA],
      ], progress);
    case "throwWhiff":
      return sampleTimeline([
        [0, POSES.idleA], [0.28, POSES.throwReach, easeOut], [0.52, POSES.throwWhiff],
        [0.74, POSES.throwWhiff], [1, POSES.idleA],
      ], progress);
    case "fireballLight":
      return sampleTimeline([
        [0, POSES.idleA], [0.34, POSES.fireballLightCharge], [0.54, POSES.fireballLightCast, easeOut],
        [0.7, POSES.fireballLightCast], [1, POSES.idleA],
      ], progress);
    case "fireballHeavy":
      return sampleTimeline([
        [0, POSES.idleA], [0.46, POSES.fireballHeavyCharge], [0.66, POSES.fireballHeavyCast, easeOut],
        [0.83, POSES.fireballHeavyCast], [1, POSES.idleA],
      ], progress);
    case "dragonPunch":
      return sampleTimeline([
        [0, POSES.idleA], [0.22, POSES.dragonCoil], [0.44, POSES.dragonRise, easeOut],
        [0.58, POSES.dragonRise], [0.78, POSES.dragonRecover], [1, POSES.idleA],
      ], progress);
    case "light":
      return sampleTimeline([
        [0, POSES.idleA], [0.25, POSES.lightWindup], [0.43, POSES.lightHit, easeOut],
        [0.62, POSES.lightHit], [1, POSES.idleA],
      ], progress);
    case "heavy":
      return sampleTimeline([
        [0, POSES.idleA], [0.36, POSES.heavyWindup], [0.57, POSES.heavyHit, easeOut],
        [0.73, POSES.heavyHit], [1, POSES.idleA],
      ], progress);
    case "special":
      return sampleTimeline([
        [0, POSES.idleA], [0.35, POSES.specialWindup], [0.55, POSES.specialCast, easeOut],
        [0.78, POSES.specialCast], [1, POSES.idleA],
      ], progress);
    case "block":
      return sampleTimeline([[0, POSES.idleA], [0.25, POSES.block, easeOut], [1, POSES.block]], progress);
    case "hit":
      return sampleTimeline([[0, POSES.idleA], [0.22, POSES.hit, easeOut], [0.72, POSES.hit], [1, POSES.idleA]], progress);
    case "knockdown":
      return sampleTimeline([[0, POSES.hit], [0.68, POSES.knockdown], [1, POSES.knockdown]], progress);
    case "ko":
      return sampleTimeline([[0, POSES.hit], [0.72, POSES.ko], [1, POSES.ko]], progress);
    default:
      return POSES.idleA;
  }
}

function facingSign(value, fallback) {
  if (typeof value === "number" && value !== 0) return value < 0 ? -1 : 1;
  const direction = String(value ?? "").toLowerCase();
  if (direction === "left" || direction === "west" || direction === "backward") return -1;
  if (direction === "right" || direction === "east" || direction === "forward") return 1;
  return fallback;
}

function interpolateCoordinate(entity, key, alpha, fallback) {
  const current = Number.isFinite(entity?.[key]) ? entity[key] : fallback;
  const capitalized = key[0].toUpperCase() + key.slice(1);
  const previous = [entity?.[`prev${capitalized}`], entity?.[`previous${capitalized}`], entity?.[`last${capitalized}`]]
    .find(Number.isFinite);
  return previous === undefined ? current : lerp(previous, current, clamp(alpha));
}

function normalizeArena(arena = {}) {
  const sourceWidth = Number.isFinite(arena.width) && arena.width > 0 ? arena.width : LOGICAL_WIDTH;
  const sourceHeight = Number.isFinite(arena.height) && arena.height > 0 ? arena.height : LOGICAL_HEIGHT;
  const scaleX = LOGICAL_WIDTH / sourceWidth;
  const scaleY = LOGICAL_HEIGHT / sourceHeight;
  const sourceLeft = Number.isFinite(arena.left) ? arena.left : (Number.isFinite(arena.x) ? arena.x : sourceWidth * 0.0625);
  const sourceRight = Number.isFinite(arena.right)
    ? arena.right
    : sourceWidth * 0.9375;
  const sourceGroundY = [arena.groundY, arena.floorY, arena.bottom].find(Number.isFinite) ?? sourceHeight * 0.82;
  const sourceTop = Number.isFinite(arena.top) ? arena.top : sourceHeight / 6;
  return {
    left: sourceLeft * scaleX,
    right: sourceRight * scaleX,
    groundY: sourceGroundY * scaleY,
    top: sourceTop * scaleY,
    sourceWidth,
    sourceHeight,
    sourceGroundY,
    scaleX,
    scaleY,
    mapX: (value) => value * scaleX,
    mapY: (value) => value * scaleY,
  };
}

function traceLimb(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length; index += 1) ctx.lineTo(points[index][0], points[index][1]);
  ctx.stroke();
}

function strokeLimb(ctx, points, color, width = 8, alpha = 1) {
  withAlpha(ctx, alpha, () => {
    ctx.strokeStyle = "rgba(4, 7, 14, 0.92)";
    ctx.lineWidth = width + 5;
    traceLimb(ctx, points);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    traceLimb(ctx, points);
  });
}

function drawYakumoGhost(ctx, pose, color, offsetX, offsetY, alpha) {
  ctx.save();
  ctx.translate(offsetX, offsetY);
  const neck = pose.neck;
  const hip = pose.hip;
  const backShoulder = [neck[0] - 3, neck[1] + 7];
  const frontShoulder = [neck[0] + 5, neck[1] + 8];
  withAlpha(ctx, alpha, () => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    traceLimb(ctx, [neck, hip]);
    traceLimb(ctx, [backShoulder, pose.backElbow, pose.backHand]);
    traceLimb(ctx, [frontShoulder, pose.frontElbow, pose.frontHand]);
    traceLimb(ctx, [hip, pose.backKnee, pose.backFoot]);
    traceLimb(ctx, [hip, pose.frontKnee, pose.frontFoot]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pose.head[0], pose.head[1], 17, 0, TAU);
    ctx.fill();
  });
  ctx.restore();
}

function forwardImpactPoint(pose) {
  return [pose.frontHand, pose.backHand, pose.frontFoot, pose.backFoot]
    .reduce((forward, candidate) => candidate[0] > forward[0] ? candidate : forward, pose.frontHand);
}

function drawYakumoAura(ctx, pose, state, color, light) {
  const active = state.phase === "strikes";
  const intensity = active ? 0.62 + state.impactPulse * 0.38 : 0.32 + (1 - state.progress) * 0.18;
  const stageColor = state.hitIndex >= 8 ? "#ffd166" : (state.hitIndex >= 4 ? "#ff6b35" : "#ff315f");

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = stageColor;
  ctx.shadowBlur = active ? 16 + state.impactPulse * 20 : 10;

  if (active) {
    const stride = 15 + Math.abs(state.lunge) * 0.14;
    drawYakumoGhost(ctx, pose, "#ff315f", -stride, 3, 0.14 + state.impactPulse * 0.06);
    drawYakumoGhost(ctx, pose, "#ffd166", -stride * 2.05, 6, 0.07 + state.impactPulse * 0.04);

    withAlpha(ctx, 0.34 + state.impactPulse * 0.34, () => {
      ctx.strokeStyle = stageColor;
      for (let streak = 0; streak < 5; streak += 1) {
        const y = -151 + streak * 31 + ((state.hitIndex * 11 + streak * 7) % 17);
        const length = 38 + ((state.hitIndex + streak) % 3) * 19;
        ctx.lineWidth = 2 + (streak % 2) * 2;
        ctx.beginPath();
        ctx.moveTo(-72 - length, y + streak * 2);
        ctx.lineTo(-25, y);
        ctx.stroke();
      }
    });
  }

  ctx.strokeStyle = stageColor;
  withAlpha(ctx, intensity * 0.42, () => {
    for (let ring = 0; ring < 2; ring += 1) {
      ctx.lineWidth = 3 - ring;
      ctx.beginPath();
      const sweep = state.frame * 0.16 + ring * Math.PI;
      ctx.arc(4, -83, 62 + ring * 18, sweep, sweep + 1.55 + state.progress * 0.8);
      ctx.stroke();
    }
  });

  if (active) {
    const impact = forwardImpactPoint(pose);
    const impactX = impact[0] + 10;
    const impactY = impact[1];
    const slashAngle = YAKUMO_SLASH_ANGLES[state.hitIndex];
    withAlpha(ctx, 0.38 + state.impactPulse * 0.5, () => {
      ctx.strokeStyle = state.hitIndex === YAKUMO_HIT_COUNT - 1 ? "#ffffff" : light;
      ctx.lineWidth = state.hitIndex === YAKUMO_HIT_COUNT - 1 ? 11 : 7;
      ctx.beginPath();
      ctx.arc(impactX - Math.cos(slashAngle) * 45, impactY - Math.sin(slashAngle) * 45, 65, slashAngle - 0.92, slashAngle + 0.74);
      ctx.stroke();
    });

    if (state.impactPulse > 0) {
      const size = 24 + state.impactPulse * (state.hitIndex === YAKUMO_HIT_COUNT - 1 ? 54 : 31);
      const burst = ctx.createRadialGradient(impactX, impactY, 1, impactX, impactY, size);
      burst.addColorStop(0, "rgba(255,255,255,0.98)");
      burst.addColorStop(0.22, stageColor);
      burst.addColorStop(1, "rgba(255,49,95,0)");
      ctx.fillStyle = burst;
      ctx.beginPath();
      ctx.arc(impactX, impactY, size, 0, TAU);
      ctx.fill();

      ctx.strokeStyle = state.hitIndex === YAKUMO_HIT_COUNT - 1 ? "#ffffff" : stageColor;
      withAlpha(ctx, 0.78 * state.impactPulse, () => {
        for (let ray = 0; ray < 10; ray += 1) {
          const angle = ray / 10 * TAU + state.hitIndex * 0.41;
          const inner = 18 + (ray % 2) * 7;
          const outer = size + 20 + (ray % 3) * 9;
          ctx.lineWidth = ray % 3 === 0 ? 4 : 2;
          ctx.beginPath();
          ctx.moveTo(impactX + Math.cos(angle) * inner, impactY + Math.sin(angle) * inner);
          ctx.lineTo(impactX + Math.cos(angle) * outer, impactY + Math.sin(angle) * outer);
          ctx.stroke();
        }
      });
    }
  }

  ctx.shadowBlur = 0;
  ctx.strokeStyle = color;
  ctx.restore();
}

function drawFighter(ctx, fighter, index, alpha, arena) {
  const sourceX = interpolateCoordinate(fighter, "x", alpha, arena.sourceWidth * (index === 0 ? 0.3 : 0.7));
  const sourceY = interpolateCoordinate(fighter, "y", alpha, arena.sourceGroundY);
  const x = arena.mapX(sourceX);
  const baseY = arena.mapY(sourceY);
  const facing = facingSign(fighter?.facing, index === 0 ? 1 : -1);
  const color = fighter?.color || (index === 0 ? "#35b9ff" : "#ff5364");
  const dark = shadeHex(color, -0.34);
  const light = shadeHex(color, 0.28);
  const action = normalizeAction(animationActionFor(fighter));
  const fighterHeight = Math.max(1, Number(fighter?.height) || 112);
  const poseScaleX = fighterHeight * arena.scaleX / POSE_REFERENCE_HEIGHT;
  const poseScaleY = fighterHeight * arena.scaleY / POSE_REFERENCE_HEIGHT;
  const authoredDuration = Number(fighter?.actionDuration);
  const duration = authoredDuration > 0 ? authoredDuration : (ACTION_DURATIONS[action] ?? 20);
  const actionProgress = clamp((Number(fighter?.actionFrame) || 0) / duration);
  const visualState = getFighterVisualState(fighter);
  const activeVisual = visualState.phase === "active";
  const activePulse = activeVisual
    ? 0.68 + Math.sin(clamp(visualState.progress) * Math.PI) * 0.32
    : 0;
  const yakumoState = yakumoVisualState(fighter);
  let visualLift = 0;
  if (action === "dragonPunch" && !fighter?.currentMove) {
    const rise = actionProgress < 0.55
      ? easeOut(clamp(actionProgress / 0.55))
      : 1 - easeInOut(clamp((actionProgress - 0.55) / 0.45));
    const targetLift = rise * 72 * poseScaleY;
    const simulatedLift = Math.max(0, arena.groundY - baseY);
    visualLift = Math.max(0, targetLift - simulatedLift);
  }
  const y = baseY - visualLift;
  const pose = poseFor(fighter, yakumoState);

  ctx.save();
  ctx.translate(x, y);

  const airborne = Math.max(0, arena.groundY - y);
  ctx.save();
  ctx.translate(0, airborne);
  ctx.scale(1 + airborne / 900, 0.34 - Math.min(0.12, airborne / 1500));
  const shadow = ctx.createRadialGradient(0, 0, 2, 0, 0, 54);
  shadow.addColorStop(0, "rgba(0,0,0,0.48)");
  shadow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.arc(0, 0, 54, 0, TAU);
  ctx.fill();
  ctx.restore();

  ctx.scale(facing * poseScaleX, poseScaleY);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const isFireball = action === "special" || action === "fireballLight" || action === "fireballHeavy";
  const isPowerMove = isFireball || action === "dragonPunch" || Boolean(yakumoState);
  if (isPowerMove) {
    const phaseAlpha = visualState.phase === "startup"
      ? 0.22 + visualState.progress * 0.42
      : activeVisual
        ? 0.72
        : visualState.phase === "recovery"
          ? (1 - visualState.progress) * 0.34
          : 0.25;
    const pulse = phaseAlpha + Math.sin((fighter?.actionFrame ?? 0) * 0.45) * 0.08;
    ctx.strokeStyle = light;
    ctx.lineWidth = 3;
    withAlpha(ctx, pulse, () => {
      for (let ring = 0; ring < 2; ring += 1) {
        ctx.beginPath();
        ctx.arc(0, -80, 57 + ring * 14, -1.2, 1.8);
        ctx.stroke();
      }
    });
  }

  if (yakumoState) drawYakumoAura(ctx, pose, yakumoState, color, light);

  if (action === "dragonPunch" && activeVisual) {
    const streakAlpha = activePulse * 0.65;
    ctx.strokeStyle = light;
    ctx.lineCap = "round";
    withAlpha(ctx, streakAlpha, () => {
      for (let streak = 0; streak < 4; streak += 1) {
        const offset = -33 + streak * 22;
        ctx.lineWidth = 3 + (streak % 2) * 2;
        ctx.beginPath();
        ctx.moveTo(offset, -28 + streak * 5);
        ctx.lineTo(offset + 10, -155 - streak * 12);
        ctx.stroke();
      }
    });
  }

  const neck = pose.neck;
  const hip = pose.hip;
  const backShoulder = [neck[0] - 3, neck[1] + 7];
  const frontShoulder = [neck[0] + 5, neck[1] + 8];

  strokeLimb(ctx, [hip, pose.backKnee, pose.backFoot], dark, 9, 0.76);
  strokeLimb(ctx, [backShoulder, pose.backElbow, pose.backHand], dark, 8, 0.76);
  strokeLimb(ctx, [neck, hip], color, 13);
  strokeLimb(ctx, [hip, pose.frontKnee, pose.frontFoot], color, 10);
  strokeLimb(ctx, [frontShoulder, pose.frontElbow, pose.frontHand], light, 9);

  if (isFireball) {
    const centerX = (pose.backHand[0] + pose.frontHand[0]) / 2 + 4;
    const centerY = (pose.backHand[1] + pose.frontHand[1]) / 2;
    const heavyScale = action === "fireballHeavy" ? 1.55 : 1;
    const pulse = (12 + Math.sin((fighter?.actionFrame ?? 0) * 0.58) * 3) * heavyScale;
    const orb = ctx.createRadialGradient(centerX, centerY, 1, centerX, centerY, pulse * 2.4);
    orb.addColorStop(0, "rgba(255,255,255,0.96)");
    orb.addColorStop(0.28, light);
    orb.addColorStop(1, "rgba(83,214,255,0)");
    const orbAlpha = visualState.phase === "startup"
      ? 0.2 + visualState.progress * 0.64
      : activeVisual
        ? 1
        : visualState.phase === "recovery"
          ? Math.max(0, 0.48 * (1 - visualState.progress))
          : 0.2;
    withAlpha(ctx, orbAlpha, () => {
      ctx.fillStyle = orb;
      ctx.beginPath();
      ctx.arc(centerX, centerY, pulse * 2.4, 0, TAU);
      ctx.fill();
    });
  }

  const heavyStrike = action === "highHeavy" || action === "midHeavy" || action === "lowHeavy";
  if (heavyStrike && activeVisual) {
    const trailAlpha = activePulse * 0.72;
    ctx.strokeStyle = light;
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    withAlpha(ctx, trailAlpha, () => {
      ctx.beginPath();
      if (action === "highHeavy") ctx.arc(20, -131, 94, -2.15, -0.03);
      else if (action === "midHeavy") ctx.arc(14, -84, 105, -1.4, 0.3);
      else ctx.arc(6, -9, 118, -1.15, 0.02);
      ctx.stroke();
    });
  }

  if (action === "airLight" && activeVisual) {
    const accentAlpha = activePulse * 0.72;
    ctx.strokeStyle = light;
    ctx.lineCap = "round";
    withAlpha(ctx, accentAlpha, () => {
      for (let line = 0; line < 3; line += 1) {
        ctx.lineWidth = 5 - line;
        ctx.beginPath();
        ctx.moveTo(pose.frontHand[0] - 75 - line * 9, pose.frontHand[1] - 10 + line * 10);
        ctx.lineTo(pose.frontHand[0] - 18, pose.frontHand[1] - 7 + line * 7);
        ctx.stroke();
      }
    });
  }

  if (action === "airHeavy" && activeVisual) {
    const accentAlpha = activePulse * 0.72;
    ctx.strokeStyle = light;
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    withAlpha(ctx, accentAlpha, () => {
      ctx.beginPath();
      ctx.moveTo(5, -89);
      ctx.quadraticCurveTo(86, -78, pose.frontFoot[0] + 13, pose.frontFoot[1] + 8);
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(34, -93);
      ctx.quadraticCurveTo(91, -63, pose.frontFoot[0] + 25, pose.frontFoot[1] + 18);
      ctx.stroke();
    });
  }

  if (action === "airTatsu" && activeVisual) {
    const accentAlpha = activePulse * 0.78;
    ctx.strokeStyle = light;
    ctx.lineCap = "round";
    withAlpha(ctx, accentAlpha, () => {
      for (let arc = 0; arc < 3; arc += 1) {
        ctx.lineWidth = 7 - arc * 2;
        ctx.beginPath();
        ctx.arc(7, -78, 112 - arc * 14, -2.65 + arc * 0.16, 2.72 - arc * 0.13);
        ctx.stroke();
      }
    });
  }

  if (action === "airHammer" && activeVisual) {
    const accentAlpha = activePulse * 0.68;
    ctx.strokeStyle = light;
    ctx.lineCap = "round";
    withAlpha(ctx, accentAlpha, () => {
      for (let streak = 0; streak < 4; streak += 1) {
        const xOffset = 14 + streak * 16;
        ctx.lineWidth = 6 - streak * 0.8;
        ctx.beginPath();
        ctx.moveTo(xOffset - 10, -104 + streak * 4);
        ctx.lineTo(xOffset + 4, -17 + streak * 7);
        ctx.stroke();
      }
    });
  }

  const isRekka = !yakumoState && (action === "rekkaLight" || action === "rekkaHeavy");
  if (isRekka && activeVisual) {
    const accentAlpha = activePulse * 0.86;
    const hand = pose.frontHand;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = "#ff5b35";
    ctx.shadowBlur = action === "rekkaHeavy" ? 18 : 11;
    withAlpha(ctx, accentAlpha, () => {
      ctx.strokeStyle = "#ff6b35";
      ctx.lineWidth = action === "rekkaHeavy" ? 11 : 7;
      ctx.beginPath();
      ctx.moveTo(hand[0] + 7, hand[1]);
      ctx.quadraticCurveTo(hand[0] - 22, hand[1] - 30, hand[0] - 48, hand[1] + 5);
      ctx.quadraticCurveTo(hand[0] - 66, hand[1] + 23, hand[0] - 82, hand[1] - 2);
      ctx.stroke();
      ctx.strokeStyle = "#ffd166";
      ctx.lineWidth = action === "rekkaHeavy" ? 5 : 3;
      ctx.beginPath();
      ctx.moveTo(hand[0] + 10, hand[1] - 1);
      ctx.quadraticCurveTo(hand[0] - 20, hand[1] - 18, hand[0] - 45, hand[1] + 3);
      ctx.stroke();
      if (action === "rekkaHeavy") {
        ctx.strokeStyle = "#ff8a38";
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(pose.backHand[0] + 4, pose.backHand[1]);
        ctx.quadraticCurveTo(pose.backHand[0] - 27, pose.backHand[1] - 25, pose.backHand[0] - 58, pose.backHand[1] + 8);
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  for (const [hand, handColor, size] of [
    [pose.backHand, dark, 7],
    [pose.frontHand, light, action === "heavy" || action.endsWith("Heavy") ? 10 : 8],
  ]) {
    ctx.fillStyle = "rgba(4,7,14,0.94)";
    ctx.beginPath();
    ctx.arc(hand[0], hand[1], size + 3, 0, TAU);
    ctx.fill();
    ctx.fillStyle = handColor;
    ctx.beginPath();
    ctx.arc(hand[0], hand[1], size, 0, TAU);
    ctx.fill();
  }

  const [headX, headY] = pose.head;
  ctx.fillStyle = "rgba(4,7,14,0.95)";
  ctx.beginPath();
  ctx.arc(headX, headY, 24, 0, TAU);
  ctx.fill();
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.arc(headX, headY, 19, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.82)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(headX + 7, headY - 2);
  ctx.lineTo(headX + 18, headY - 4);
  ctx.stroke();

  if (action === "block") {
    ctx.strokeStyle = "rgba(169, 231, 255, 0.72)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(22, -96, 49, -1.15, 1.15);
    ctx.stroke();
  }

  ctx.restore();
  return { x, y, action };
}

function drawBackground(ctx, arena, time) {
  const sky = ctx.createLinearGradient(0, 0, 0, arena.groundY);
  sky.addColorStop(0, "#080b1d");
  sky.addColorStop(0.62, "#1e3157");
  sky.addColorStop(1, "#d95757");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

  const glow = ctx.createRadialGradient(640, 205, 10, 640, 205, 260);
  glow.addColorStop(0, "rgba(255,205,145,0.42)");
  glow.addColorStop(1, "rgba(255,128,100,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(300, 0, 680, 500);

  ctx.fillStyle = "rgba(255, 220, 169, 0.82)";
  ctx.beginPath();
  ctx.arc(640, 200, 58, 0, TAU);
  ctx.fill();

  const parallax = Math.sin(time * 0.00009) * 5;
  ctx.fillStyle = "#11172b";
  ctx.beginPath();
  ctx.moveTo(0, 445);
  for (let x = -20; x <= LOGICAL_WIDTH + 40; x += 70) {
    const height = 55 + ((x / 70) % 4 + 4) % 4 * 22;
    ctx.lineTo(x + parallax, 445 - height);
    ctx.lineTo(x + 48 + parallax, 445 - height);
    ctx.lineTo(x + 48 + parallax, 445);
  }
  ctx.lineTo(LOGICAL_WIDTH, 470);
  ctx.lineTo(0, 470);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(247, 186, 123, 0.45)";
  for (let x = 25; x < LOGICAL_WIDTH; x += 70) {
    const y = 355 + ((x / 70) % 3) * 22;
    ctx.fillRect(x + parallax, y, 12, 4);
  }

  const floor = ctx.createLinearGradient(0, arena.groundY - 25, 0, LOGICAL_HEIGHT);
  floor.addColorStop(0, "#22283a");
  floor.addColorStop(1, "#090c13");
  ctx.fillStyle = floor;
  ctx.beginPath();
  ctx.moveTo(0, arena.groundY - 15);
  ctx.lineTo(LOGICAL_WIDTH, arena.groundY - 15);
  ctx.lineTo(LOGICAL_WIDTH, LOGICAL_HEIGHT);
  ctx.lineTo(0, LOGICAL_HEIGHT);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 2;
  for (let offset = 0; offset < 7; offset += 1) {
    const y = arena.groundY + offset * offset * 3.7;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(LOGICAL_WIDTH, y);
    ctx.stroke();
  }
  for (let x = -500; x <= 1700; x += 115) {
    ctx.beginPath();
    ctx.moveTo(640, arena.groundY - 15);
    ctx.lineTo(x, LOGICAL_HEIGHT);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(255, 184, 112, 0.48)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(arena.left, arena.groundY - 15);
  ctx.lineTo(arena.right, arena.groundY - 15);
  ctx.stroke();
}

function drawProjectile(ctx, projectile, alpha, fallbackColor, arena) {
  const x = arena.mapX(interpolateCoordinate(projectile, "x", alpha, 0));
  const y = arena.mapY(interpolateCoordinate(projectile, "y", alpha, 0));
  const authoredRadius = projectile?.radius
    ?? projectile?.size
    ?? (Number.isFinite(projectile?.width) ? projectile.width / 2 : 18);
  const radius = clamp(authoredRadius * Math.min(arena.scaleX, arena.scaleY), 5, 64);
  const color = projectile?.color || fallbackColor || "#6ee7ff";
  const direction = facingSign(projectile?.facing ?? projectile?.vx, 1);
  const frame = projectile?.frame ?? projectile?.age ?? 0;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(direction, 1);
  const trail = ctx.createLinearGradient(-radius * 4, 0, radius, 0);
  trail.addColorStop(0, "rgba(255,255,255,0)");
  trail.addColorStop(1, color);
  ctx.fillStyle = trail;
  ctx.beginPath();
  ctx.moveTo(-radius * (3.5 + Math.sin(frame * 0.4) * 0.3), 0);
  ctx.lineTo(-radius * 0.4, -radius * 0.75);
  ctx.quadraticCurveTo(radius * 0.7, 0, -radius * 0.4, radius * 0.75);
  ctx.closePath();
  withAlpha(ctx, 0.6, () => ctx.fill());

  ctx.shadowColor = color;
  ctx.shadowBlur = radius * 1.5;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, TAU);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.beginPath();
  ctx.arc(radius * 0.2, -radius * 0.16, radius * 0.43, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function effectProgress(effect) {
  if (Number.isFinite(effect?.progress)) return clamp(effect.progress);
  const age = [effect?.age, effect?.frame].find(Number.isFinite);
  const duration = [effect?.duration, effect?.maxLife, effect?.totalLife, effect?.maxLifeFrames].find(Number.isFinite);
  if (age !== undefined && duration !== undefined && duration > 0) return clamp(age / duration);
  if (Number.isFinite(effect?.life) && Number.isFinite(effect?.maxLife) && effect.maxLife > 0) {
    return clamp(1 - effect.life / effect.maxLife);
  }
  return clamp((age ?? 0) / 20);
}

function effectVisualStyle(type) {
  const compact = type.replace(/[^a-z0-9]/g, "");
  if (compact.includes("punishcounter")) {
    return { color: "#ff405f", size: 48, rays: 16, rings: 2, label: "PUNISH COUNTER" };
  }
  if (compact.includes("counter")) {
    return { color: "#ff7b53", size: 42, rays: 14, rings: 1, label: "COUNTER" };
  }
  if (compact.includes("super")) {
    return { color: "#ffe15f", size: 58, rays: 18, rings: 3, label: "SUPER" };
  }
  if (compact === "ex" || compact.startsWith("ex") || compact.includes("overdrive")) {
    return { color: "#63f5ff", size: 47, rays: 14, rings: 2, label: "EX" };
  }
  if (compact.includes("groundbounce")) {
    return { color: "#ffb14a", size: 48, rays: 12, rings: 2, label: "GROUND BOUNCE" };
  }
  if (compact.includes("wallbounce")) {
    return { color: "#a68cff", size: 48, rays: 12, rings: 2, label: "WALL BOUNCE" };
  }
  if (type.includes("block")) return { color: "#8de8ff", size: 30, rays: 10, rings: 1, label: "" };
  return { color: "#ffd166", size: 32, rays: 10, rings: 1, label: "" };
}

function drawEffect(ctx, effect, arena) {
  const type = String(effect?.type ?? "hit").toLowerCase();
  const x = arena.mapX(Number.isFinite(effect?.x) ? effect.x : 0);
  const y = arena.mapY(Number.isFinite(effect?.y) ? effect.y : 0);
  const progress = effectProgress(effect);
  const visual = effectVisualStyle(type);
  const color = effect?.color || visual.color;
  const size = effect?.size ?? visual.size;

  ctx.save();
  ctx.translate(x, y);
  if (type.includes("dust")) {
    withAlpha(ctx, 1 - progress, () => {
      ctx.fillStyle = color;
      for (let index = 0; index < 5; index += 1) {
        const angle = index * 1.31;
        ctx.beginPath();
        ctx.arc(Math.cos(angle) * progress * 38, -Math.abs(Math.sin(angle)) * progress * 22, 7 - progress * 4, 0, TAU);
        ctx.fill();
      }
    });
  } else if (type.includes("text")) {
    ctx.fillStyle = color;
    ctx.font = "900 24px system-ui, sans-serif";
    ctx.textAlign = "center";
    withAlpha(ctx, 1 - progress, () => ctx.fillText(effect?.text ?? "HIT", 0, -progress * 42));
  } else {
    ctx.rotate((effect?.rotation ?? 0) + progress * 0.28);
    withAlpha(ctx, 1 - progress, () => {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineCap = "round";
      for (let ray = 0; ray < visual.rays; ray += 1) {
        const angle = (ray / visual.rays) * TAU;
        const inner = size * (0.18 + progress * 0.65);
        const outer = size * (0.9 + progress * 1.25) * (ray % 2 ? 0.68 : 1);
        ctx.lineWidth = ray % 2 ? 3 : 6;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
        ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(0, 0, size * (0.68 - progress * 0.36), 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 4;
      for (let ring = 0; ring < visual.rings; ring += 1) {
        ctx.beginPath();
        ctx.arc(0, 0, size * (0.88 + progress + ring * 0.34), 0, TAU);
        ctx.stroke();
      }
    });
    if (visual.label) {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "rgba(3,6,14,0.9)";
      ctx.lineWidth = 5;
      ctx.font = "italic 1000 16px Impact, system-ui, sans-serif";
      ctx.textAlign = "center";
      withAlpha(ctx, 1 - progress, () => {
        const labelY = -size - progress * 28;
        ctx.strokeText(visual.label, 0, labelY);
        ctx.fillText(visual.label, 0, labelY);
      });
    }
  }
  ctx.restore();
}

function drawBar(ctx, { x, y, width, height, value, trail, color, flip = false }) {
  roundedRect(ctx, x, y, width, height, height * 0.25);
  ctx.fillStyle = "rgba(3,6,14,0.86)";
  ctx.fill();

  const inset = 5;
  const innerWidth = width - inset * 2;
  const innerHeight = height - inset * 2;
  const drawValue = (amount, fillStyle) => {
    const filled = innerWidth * clamp(amount);
    if (filled <= 0) return;
    const left = flip ? x + width - inset - filled : x + inset;
    roundedRect(ctx, left, y + inset, filled, innerHeight, Math.min(5, filled / 2));
    ctx.fillStyle = fillStyle;
    ctx.fill();
  };
  drawValue(trail, "rgba(255,238,168,0.74)");
  const gradient = ctx.createLinearGradient(x, y, x, y + height);
  gradient.addColorStop(0, shadeHex(color, 0.28));
  gradient.addColorStop(1, shadeHex(color, -0.16));
  drawValue(value, gradient);

  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 2;
  roundedRect(ctx, x, y, width, height, height * 0.25);
  ctx.stroke();
}

function firstFiniteValue(...values) {
  return values.find(Number.isFinite);
}

function readGauge(fighter, kind) {
  const resources = fighter?.resources ?? fighter?.gauges ?? {};
  let source;
  let explicitMax;
  let defaults;
  if (kind === "super") {
    source = resources?.super
      ?? resources?.superMeter
      ?? resources?.meter
      ?? resources?.power
      ?? fighter?.superMeter
      ?? fighter?.superGauge
      ?? fighter?.powerMeter
      ?? fighter?.meter
      ?? fighter?.energy;
    explicitMax = firstFiniteValue(
      fighter?.maxSuperMeter,
      fighter?.maxMeter,
      fighter?.maxEnergy,
      resources?.maxSuper,
    );
    defaults = { max: 300, segments: 3, label: "SUPER", color: "#ffd166" };
  } else if (kind === "drive") {
    source = resources?.drive ?? resources?.driveGauge ?? fighter?.driveGauge ?? fighter?.drive;
    explicitMax = firstFiniteValue(fighter?.maxDriveGauge, fighter?.maxDrive, resources?.maxDrive);
    defaults = { max: 600, segments: 6, label: "DRIVE", color: "#47e6d3" };
  } else {
    source = resources?.guard
      ?? resources?.guardGauge
      ?? fighter?.guardGauge
      ?? fighter?.guardResource;
    explicitMax = firstFiniteValue(fighter?.maxGuardGauge, fighter?.maxGuard, resources?.maxGuard);
    defaults = { max: 100, segments: 1, label: "GUARD", color: "#8aa7ff" };
  }
  if (source == null || typeof source === "boolean") return null;

  const object = source && typeof source === "object" ? source : null;
  const value = object
    ? firstFiniteValue(object.value, object.current, object.amount, object.points, object.meter, object.stocks)
    : (Number.isFinite(source) ? source : undefined);
  if (!Number.isFinite(value)) return null;
  const max = firstFiniteValue(
    object?.max,
    object?.maximum,
    object?.maxValue,
    object?.capacity,
    object?.maxStocks,
    explicitMax,
    defaults.max,
  );
  if (!Number.isFinite(max) || max <= 0) return null;
  const segments = Math.max(1, Math.min(10, Math.round(firstFiniteValue(
    object?.segments,
    object?.maxStocks,
    defaults.segments,
  ))));
  return {
    value: clamp(value, 0, max),
    max,
    segments,
    label: String(object?.label ?? defaults.label),
    color: String(object?.color ?? defaults.color),
  };
}

function drawResourceGauge(ctx, { x, y, width, height, gauge, flip = false }) {
  if (!gauge) return;
  roundedRect(ctx, x, y, width, height, Math.min(4, height * 0.3));
  ctx.fillStyle = "rgba(3,6,14,0.88)";
  ctx.fill();

  const inset = 2;
  const innerWidth = width - inset * 2;
  const innerHeight = height - inset * 2;
  const fraction = clamp(gauge.value / gauge.max);
  const filled = innerWidth * fraction;
  if (filled > 0) {
    const left = flip ? x + width - inset - filled : x + inset;
    const gradient = ctx.createLinearGradient(x, y, x, y + height);
    gradient.addColorStop(0, shadeHex(gauge.color, 0.3));
    gradient.addColorStop(1, shadeHex(gauge.color, -0.2));
    ctx.fillStyle = gradient;
    ctx.fillRect(left, y + inset, filled, innerHeight);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  for (let segment = 1; segment < gauge.segments; segment += 1) {
    const dividerX = x + (width * segment) / gauge.segments;
    ctx.beginPath();
    ctx.moveTo(dividerX, y + 1);
    ctx.lineTo(dividerX, y + height - 1);
    ctx.stroke();
  }
  roundedRect(ctx, x, y, width, height, Math.min(4, height * 0.3));
  ctx.stroke();

  ctx.font = `900 ${Math.max(7, height - 4)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.textAlign = flip ? "right" : "left";
  ctx.fillText(gauge.label, flip ? x + width - 6 : x + 6, y + height / 2 + 0.5);
  ctx.textAlign = flip ? "left" : "right";
  ctx.fillText(
    `${Math.floor(gauge.value)}/${Math.floor(gauge.max)}`,
    flip ? x + 6 : x + width - 6,
    y + height / 2 + 0.5,
  );
}

function comboFor(game, fighter, index) {
  const globalCombo = game?.combo ?? game?.comboState ?? game?.comboCounter;
  const shared = Array.isArray(globalCombo) ? globalCombo[index] : globalCombo;
  const sharedOwner = shared?.attackerId ?? shared?.owner ?? shared?.sourceId;
  const candidate = game?.combos?.[index]
    ?? game?.comboStates?.[index]
    ?? game?.comboCounters?.[index]
    ?? (shared && (sharedOwner == null || sharedOwner === index) ? shared : null)
    ?? fighter?.combo
    ?? fighter?.currentCombo
    ?? (Number.isFinite(fighter?.comboCount) || Number.isFinite(fighter?.comboHits)
      ? { hits: fighter?.comboCount ?? fighter?.comboHits, damage: fighter?.comboDamage }
      : null);
  if (candidate == null) return null;
  const hits = Number.isFinite(candidate)
    ? candidate
    : firstFiniteValue(candidate?.hits, candidate?.hitCount, candidate?.count, fighter?.comboCount, fighter?.comboHits);
  if (!Number.isFinite(hits) || hits < 2 || candidate?.active === false) return null;
  const damage = Number.isFinite(candidate)
    ? firstFiniteValue(fighter?.comboDamage, 0)
    : firstFiniteValue(candidate?.damage, candidate?.totalDamage, candidate?.scaledDamage, fighter?.comboDamage, 0);
  return { hits: Math.floor(hits), damage: Math.max(0, Math.floor(damage)) };
}

function drawComboHud(ctx, game, fighter, index) {
  const combo = comboFor(game, fighter, index);
  if (!combo) return;
  const x = index === 0 ? 76 : LOGICAL_WIDTH - 76;
  ctx.save();
  ctx.textAlign = index === 0 ? "left" : "right";
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(3,6,14,0.92)";
  ctx.lineWidth = 6;
  ctx.font = "italic 1000 28px Impact, system-ui, sans-serif";
  ctx.strokeText(`${combo.hits} HIT`, x, 145);
  ctx.fillText(`${combo.hits} HIT`, x, 145);
  if (combo.damage > 0) {
    ctx.font = "800 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#ffd166";
    ctx.fillText(`${combo.damage} DAMAGE`, x, 160);
  }
  ctx.restore();
}

function agentIntentFor(game, fighter, index) {
  const shared = game?.aiDebug?.[index]
    ?? game?.agentDebug?.[index]
    ?? game?.aiIntents?.[index]
    ?? game?.intents?.[index]
    ?? game?.aiTelemetry?.[index]
    ?? game?.agentTelemetry?.[index];
  const source = shared ?? fighter?.aiDebug ?? fighter?.agentDebug ?? fighter?.aiTelemetry;
  const intent = typeof source === "string"
    ? source
    : source?.intent
      ?? source?.name
      ?? source?.id
      ?? fighter?.aiIntent
      ?? fighter?.intent
      ?? fighter?.ai?.intent;
  if (intent == null || !String(intent).trim()) return null;
  const reason = typeof source === "object"
    ? source?.reason ?? source?.why ?? source?.rationale ?? fighter?.aiReason ?? fighter?.ai?.reason
    : fighter?.aiReason ?? fighter?.ai?.reason;
  return {
    intent: String(intent).slice(0, 36),
    reason: reason == null ? "" : String(reason).slice(0, 58),
  };
}

function drawAgentIntentHud(ctx, game, fighter, index) {
  const data = agentIntentFor(game, fighter, index);
  if (!data) return;
  const width = 300;
  const x = index === 0 ? 72 : LOGICAL_WIDTH - 72 - width;
  const y = 170;
  roundedRect(ctx, x, y, width, data.reason ? 35 : 23, 5);
  ctx.fillStyle = "rgba(3,6,14,0.72)";
  ctx.fill();
  ctx.textAlign = index === 0 ? "left" : "right";
  const textX = index === 0 ? x + 8 : x + width - 8;
  ctx.textBaseline = "top";
  ctx.font = "800 10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = index === 0 ? "#72d4ff" : "#ff8c99";
  ctx.fillText(`INTENT · ${data.intent}`, textX, y + 5);
  if (data.reason) {
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "rgba(222,231,244,0.78)";
    ctx.fillText(data.reason, textX, y + 19);
  }
}

function drawHud(ctx, game, fighters, hudState, deltaMs) {
  const left = fighters[0] ?? {};
  const right = fighters[1] ?? {};
  const configs = [
    { fighter: left, x: 72, flip: false, fallback: "#35b9ff", label: "PLAYER 1" },
    { fighter: right, x: 748, flip: true, fallback: "#ff5364", label: "PLAYER 2" },
  ];

  configs.forEach(({ fighter, x, flip, fallback, label }, index) => {
    const maxHealth = Math.max(1, Number(fighter?.maxHealth) || 100);
    const health = clamp((Number(fighter?.health) || 0) / maxHealth);
    if (!Number.isFinite(hudState.healthTrails[index])) hudState.healthTrails[index] = health;
    if (health > hudState.healthTrails[index]) hudState.healthTrails[index] = health;
    const decay = clamp(deltaMs / 680, 0, 0.12);
    hudState.healthTrails[index] = lerp(hudState.healthTrails[index], health, decay);
    const color = fighter?.color || fallback;

    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = "800 17px system-ui, sans-serif";
    ctx.textAlign = flip ? "right" : "left";
    ctx.fillText(String(fighter?.name || label).toUpperCase(), flip ? x + 460 : x, 31);
    drawBar(ctx, {
      x, y: 40, width: 460, height: 33, value: health,
      trail: hudState.healthTrails[index], color, flip,
    });

    const superGauge = readGauge(fighter, "super");
    const driveGauge = readGauge(fighter, "drive");
    const guardGauge = readGauge(fighter, "guard");
    const secondaryGauge = String(fighter?.templateId ?? "").toLowerCase() === "ember"
      ? (guardGauge ?? driveGauge)
      : (driveGauge ?? guardGauge);
    drawResourceGauge(ctx, { x, y: 80, width: 300, height: 14, gauge: superGauge, flip });
    drawResourceGauge(ctx, {
      x,
      y: superGauge ? 98 : 80,
      width: 300,
      height: 10,
      gauge: secondaryGauge,
      flip,
    });

    const rounds = Array.isArray(fighter?.rounds)
      ? fighter.rounds.filter(Boolean).length
      : Math.max(0, Number(fighter?.rounds ?? fighter?.roundsWon) || 0);
    for (let round = 0; round < 3; round += 1) {
      const markerX = flip ? x + 442 - round * 22 : x + 18 + round * 22;
      ctx.fillStyle = round < rounds ? "#ffd166" : "rgba(255,255,255,0.14)";
      ctx.strokeStyle = "rgba(3,6,14,0.9)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(markerX, 118, 7, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
  });

  fighters.slice(0, 2).forEach((fighter, index) => {
    drawComboHud(ctx, game, fighter, index);
    drawAgentIntentHud(ctx, game, fighter, index);
  });

  roundedRect(ctx, 570, 27, 140, 75, 12);
  ctx.fillStyle = "rgba(3,6,14,0.84)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 2;
  ctx.stroke();
  const seconds = Number.isFinite(game?.timerFrames) ? Math.max(0, Math.ceil(game.timerFrames / 60)) : 99;
  ctx.fillStyle = seconds <= 10 ? "#ff6b6b" : "#ffffff";
  ctx.font = "900 46px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillText(String(seconds).padStart(2, "0"), 640, 81);
}

function promptFor(game, fighters) {
  if (game?.prompt) return { title: String(game.prompt), subtitle: game?.promptSubtitle || "" };
  const phase = String(game?.phase ?? "").toLowerCase();
  // The TOD showcase owns its result timing. Keep the terminal pose, empty
  // health bar and 16 HIT HUD unobscured until the delayed verification card.
  if (game?.presentationMode === "tod-exhibition" && phase.includes("matchover")) return null;
  if (phase.includes("matchover") || phase.includes("gameover") || phase.includes("victory")) {
    const winner = fighters.find((fighter) => (fighter?.health ?? 0) > 0);
    return { title: "VICTORY", subtitle: winner?.name ? String(winner.name).toUpperCase() : "MATCH OVER" };
  }
  if (phase === "ko" || phase.includes("knockout")) return { title: "K.O.", subtitle: "" };
  if (phase.includes("roundover")) {
    return { title: String(game?.roundReason).toLowerCase() === "time" ? "TIME" : "K.O.", subtitle: "" };
  }
  if (phase.includes("fightintro") || phase === "fight_start" || phase === "fightstart") return { title: "FIGHT!", subtitle: "" };
  if (phase.includes("roundintro") || phase.includes("round_start") || phase.includes("roundstart") || phase === "ready") {
    const round = game?.round ?? game?.roundNumber;
    return { title: round ? `ROUND ${round}` : "READY", subtitle: "" };
  }
  if (fighters.some((fighter) => normalizeAction(animationActionFor(fighter)) === "ko")) return { title: "K.O.", subtitle: "" };
  return null;
}

function drawPrompt(ctx, prompt) {
  if (!prompt) return;
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "italic 1000 104px Impact, Haettenschweiler, system-ui, sans-serif";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(4,7,14,0.92)";
  ctx.lineWidth = 18;
  ctx.strokeText(prompt.title, 640, 325);
  const gradient = ctx.createLinearGradient(0, 245, 0, 330);
  gradient.addColorStop(0, "#fff7d6");
  gradient.addColorStop(0.48, "#ffc34d");
  gradient.addColorStop(1, "#ff574d");
  ctx.fillStyle = gradient;
  ctx.fillText(prompt.title, 640, 325);
  if (prompt.subtitle) {
    ctx.font = "900 24px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.strokeStyle = "rgba(4,7,14,0.9)";
    ctx.lineWidth = 7;
    ctx.strokeText(prompt.subtitle, 640, 368);
    ctx.fillText(prompt.subtitle, 640, 368);
  }
  ctx.restore();
}

const DEBUG_BOX_STYLES = Object.freeze({
  hurt: {
    fill: "rgba(31, 224, 187, 0.25)",
    stroke: "rgba(52, 255, 215, 0.96)",
    label: "hurt",
  },
  hit: {
    fill: "rgba(255, 55, 78, 0.28)",
    stroke: "rgba(255, 83, 103, 0.98)",
    label: "hit",
  },
  projectile: {
    fill: "rgba(255, 151, 40, 0.28)",
    stroke: "rgba(255, 174, 67, 0.98)",
    label: "projectile",
  },
  unknown: {
    fill: "rgba(220, 230, 244, 0.18)",
    stroke: "rgba(220, 230, 244, 0.82)",
    label: "unknown",
  },
});

function debugNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function debugCount(value) {
  const number = debugNumber(value);
  return number === null ? "–" : String(Math.max(0, Math.trunc(number)));
}

function debugRecoveryLabel(frameData) {
  const recovery = debugNumber(frameData?.recovery);
  const landing = debugNumber(frameData?.landingRecovery);
  const timeline = debugNumber(frameData?.timelineRecovery);
  if (recovery === null) return "–";
  if (landing > 0 && timeline === recovery + landing) {
    return `${Math.trunc(recovery)}+L${Math.trunc(landing)}`;
  }
  if (timeline !== null && timeline !== recovery) {
    return `${Math.trunc(recovery)}/T${Math.trunc(timeline)}`;
  }
  return String(Math.max(0, Math.trunc(recovery)));
}

function debugPhase(frameData, frame) {
  if (frameData?.phase != null && String(frameData.phase).trim()) return String(frameData.phase);
  const startup = debugNumber(frameData?.startup);
  const active = debugNumber(frameData?.active);
  if (frame === null || startup === null || active === null) return "–";
  if (frame < startup) return "startup";
  if (frame < startup + active) return "active";
  return "recovery";
}

function drawDebugLegend(ctx, arena) {
  const entries = [DEBUG_BOX_STYLES.hurt, DEBUG_BOX_STYLES.hit, DEBUG_BOX_STYLES.projectile];
  const widths = [58, 50, 91];
  const gap = 8;
  const width = widths.reduce((sum, value) => sum + value, 0) + gap * (entries.length - 1) + 16;
  const height = 24;
  const x = (arena.left + arena.right - width) / 2;
  const y = arena.top + 6;

  roundedRect(ctx, x, y, width, height, 6);
  ctx.fillStyle = "rgba(3, 6, 14, 0.84)";
  ctx.fill();

  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  let cursor = x + 8;
  entries.forEach((entry, index) => {
    ctx.fillStyle = entry.fill;
    ctx.fillRect(cursor, y + 6, 12, 12);
    ctx.strokeStyle = entry.stroke;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cursor, y + 6, 12, 12);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillText(entry.label, cursor + 17, y + height / 2);
    cursor += widths[index] + gap;
  });
}

function drawDebugFramePanel(ctx, game, arena, index) {
  const frameData = Array.isArray(game?.frameData) ? (game.frameData[index] ?? {}) : {};
  const fighter = Array.isArray(game?.fighters) ? (game.fighters[index] ?? {}) : {};
  const action = frameData?.action ?? fighter?.action ?? "–";
  const frame = debugNumber(frameData?.frame) ?? debugNumber(fighter?.actionFrame);
  const phase = debugPhase(frameData, frame);
  const template = frameData?.templateName ?? fighter?.templateName ?? fighter?.templateId;
  const side = `P${index + 1}`;
  const heading = template == null || String(template).trim() === ""
    ? side
    : `${side} · ${String(template)}`;
  const frameLabel = frame === null ? "F–" : `F${Math.max(0, Math.trunc(frame))}`;
  const panelWidth = 270;
  const panelHeight = 66;
  const panelY = arena.top + 38;
  const panelX = index === 0 ? arena.left + 10 : arena.right - panelWidth - 10;
  const textX = index === 0 ? panelX + 10 : panelX + panelWidth - 10;

  roundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 7);
  ctx.fillStyle = "rgba(3, 6, 14, 0.86)";
  ctx.fill();
  ctx.strokeStyle = index === 0 ? "rgba(53,185,255,0.82)" : "rgba(255,83,100,0.82)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.textAlign = index === 0 ? "left" : "right";
  ctx.textBaseline = "top";
  ctx.font = "700 11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = index === 0 ? "#72d4ff" : "#ff8c99";
  ctx.fillText(heading, textX, panelY + 7);
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(`${String(action)} · ${frameLabel} · ${phase}`, textX, panelY + 24);
  ctx.fillStyle = "rgba(222,231,244,0.9)";
  ctx.fillText(
    `S ${debugCount(frameData?.startup)}  A ${debugCount(frameData?.activeFrameCount ?? frameData?.active)}  G ${debugCount(frameData?.gap)}  R ${debugRecoveryLabel(frameData)}`,
    textX,
    panelY + 43,
  );
}

function drawDebug(ctx, game, arena, fighterPositions) {
  ctx.save();
  ctx.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";
  ctx.strokeStyle = "rgba(91,255,179,0.75)";
  ctx.fillStyle = "rgba(91,255,179,0.95)";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(arena.left, arena.top, arena.right - arena.left, arena.groundY - arena.top);
  ctx.setLineDash([]);
  ctx.fillText(`arena ${Math.round(arena.left)}..${Math.round(arena.right)} ground ${Math.round(arena.groundY)}`, arena.left + 8, arena.top + 8);

  const hitboxes = Array.isArray(game?.hitboxes) ? game.hitboxes : [];
  for (const hitbox of hitboxes) {
    const x = debugNumber(hitbox?.x);
    const y = debugNumber(hitbox?.y);
    const width = debugNumber(hitbox?.width) ?? debugNumber(hitbox?.w);
    const height = debugNumber(hitbox?.height) ?? debugNumber(hitbox?.h);
    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) continue;
    const style = DEBUG_BOX_STYLES[hitbox?.type] ?? DEBUG_BOX_STYLES.unknown;
    const mappedX = arena.mapX(x);
    const mappedY = arena.mapY(y);
    const mappedWidth = width * arena.scaleX;
    const mappedHeight = height * arena.scaleY;
    ctx.fillStyle = style.fill;
    ctx.fillRect(mappedX, mappedY, mappedWidth, mappedHeight);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(mappedX, mappedY, mappedWidth, mappedHeight);
  }

  const fighters = Array.isArray(game?.fighters) ? game.fighters : [];
  fighterPositions.forEach((position, index) => {
    if (!position) return;
    const fighter = fighters[index];
    const fighterX = debugNumber(fighter?.x);
    const fighterY = debugNumber(fighter?.y);
    const footX = fighterX === null ? position.x : arena.mapX(fighterX);
    const footY = fighterY === null ? position.y : arena.mapY(fighterY);
    ctx.strokeStyle = index === 0 ? "#35b9ff" : "#ff5364";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(footX - 9, footY);
    ctx.lineTo(footX + 9, footY);
    ctx.moveTo(footX, footY - 9);
    ctx.lineTo(footX, footY + 9);
    ctx.stroke();
  });

  const frameDataCount = Array.isArray(game?.frameData) ? game.frameData.length : 0;
  const sideCount = Math.min(2, Math.max(fighterPositions.length, frameDataCount));
  for (let index = 0; index < sideCount; index += 1) drawDebugFramePanel(ctx, game, arena, index);
  drawDebugLegend(ctx, arena);
  ctx.restore();
}

export function createRenderer(canvas, { debug = false } = {}) {
  if (!canvas || typeof canvas.getContext !== "function") {
    throw new TypeError("createRenderer requires a canvas-like element");
  }
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D context is unavailable");

  let debugEnabled = Boolean(debug);
  let viewport = null;
  let lastRenderTime = now();
  const hudState = { healthTrails: [NaN, NaN] };
  let flashState = null;
  let shakeState = null;

  function measure() {
    const rect = typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect()
      : null;
    const cssWidth = Math.max(1, Math.round(rect?.width || canvas.clientWidth || canvas.width || LOGICAL_WIDTH));
    const cssHeight = Math.max(1, Math.round(rect?.height || canvas.clientHeight || canvas.height || LOGICAL_HEIGHT));
    const dpr = clamp(Number(globalThis.devicePixelRatio) || 1, 1, 2.5);
    return { cssWidth, cssHeight, dpr };
  }

  function resize() {
    const measured = measure();
    const pixelWidth = Math.max(1, Math.round(measured.cssWidth * measured.dpr));
    const pixelHeight = Math.max(1, Math.round(measured.cssHeight * measured.dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const scale = Math.min(measured.cssWidth / LOGICAL_WIDTH, measured.cssHeight / LOGICAL_HEIGHT);
    viewport = {
      ...measured,
      pixelWidth,
      pixelHeight,
      scale,
      offsetX: (measured.cssWidth - LOGICAL_WIDTH * scale) / 2,
      offsetY: (measured.cssHeight - LOGICAL_HEIGHT * scale) / 2,
    };
    return { ...viewport };
  }

  function ensureViewport() {
    const measured = measure();
    if (!viewport
      || measured.cssWidth !== viewport.cssWidth
      || measured.cssHeight !== viewport.cssHeight
      || measured.dpr !== viewport.dpr) {
      resize();
    }
  }

  function currentShake(time) {
    if (!shakeState) return [0, 0];
    const elapsed = time - shakeState.startedAt;
    const progress = clamp(elapsed / shakeState.duration);
    if (progress >= 1) {
      shakeState = null;
      return [0, 0];
    }
    const strength = shakeState.amount * (1 - progress) ** 2;
    return [
      Math.sin(elapsed * 0.107 + 1.7) * strength,
      Math.sin(elapsed * 0.173 + 4.2) * strength * 0.64,
    ];
  }

  function render(game = {}, alpha = 0) {
    ensureViewport();
    const time = now();
    const deltaMs = clamp(time - lastRenderTime, 0, 100);
    lastRenderTime = time;
    const arena = normalizeArena(game?.arena);
    const fighters = Array.isArray(game?.fighters) ? game.fighters.slice(0, 2) : [];
    const projectiles = Array.isArray(game?.projectiles) ? game.projectiles : [];
    const effects = Array.isArray(game?.effects) ? game.effects : [];
    const [shakeX, shakeY] = currentShake(time);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#03050a";
    ctx.fillRect(0, 0, viewport.pixelWidth, viewport.pixelHeight);
    const scale = viewport.scale * viewport.dpr;
    ctx.setTransform(
      scale, 0, 0, scale,
      (viewport.offsetX + shakeX) * viewport.dpr,
      (viewport.offsetY + shakeY) * viewport.dpr,
    );

    drawBackground(ctx, arena, time);
    // Debug boxes are current-tick combat data. Render entities at that same
    // tick while BOX mode is enabled so interpolation cannot make the boxes
    // appear one frame ahead of a walking, rushing, or airborne fighter.
    const entityAlpha = debugEnabled ? 1 : alpha;
    const fighterPositions = fighters.map((fighter, index) => drawFighter(ctx, fighter, index, entityAlpha, arena));

    projectiles.forEach((projectile, index) => {
      const owner = Number.isFinite(projectile?.owner) ? projectile.owner : index % 2;
      drawProjectile(ctx, projectile, entityAlpha, fighters[owner]?.color, arena);
    });
    effects.forEach((effect) => drawEffect(ctx, effect, arena));
    drawHud(ctx, game, fighters, hudState, deltaMs);
    drawPrompt(ctx, promptFor(game, fighters));

    if (flashState) {
      const progress = clamp((time - flashState.startedAt) / flashState.duration);
      if (progress >= 1) {
        flashState = null;
      } else {
        const opacity = (1 - progress) ** 2 * 0.28;
        withAlpha(ctx, opacity, () => {
          ctx.fillStyle = flashState.color;
          ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
        });
        if (flashState.message) {
          withAlpha(ctx, clamp(1 - progress * 1.15), () => {
            ctx.font = "italic 1000 54px Impact, system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.strokeStyle = "rgba(3,6,14,0.92)";
            ctx.fillStyle = "#ffffff";
            ctx.lineWidth = 12;
            ctx.strokeText(flashState.message, 640, 190 - progress * 18);
            ctx.fillText(flashState.message, 640, 190 - progress * 18);
          });
        }
      }
    }

    if (debugEnabled) drawDebug(ctx, game, arena, fighterPositions);
  }

  function setDebug(value) {
    debugEnabled = Boolean(value);
    return debugEnabled;
  }

  function flash(message, color = "#ffffff") {
    flashState = {
      message: message == null ? "" : String(message),
      color: color || "#ffffff",
      startedAt: now(),
      duration: 620,
    };
  }

  function shake(amount = 10) {
    const strength = clamp(Number(amount) || 0, 0, 40);
    shakeState = {
      amount: Math.max(strength, shakeState?.amount ?? 0),
      startedAt: now(),
      duration: 280 + strength * 5,
    };
  }

  resize();
  return { render, resize, setDebug, flash, shake };
}

export default createRenderer;
