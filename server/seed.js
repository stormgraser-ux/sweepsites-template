#!/usr/bin/env node
/**
 * Seed Script - Populate database with the full sweepstakes site roster
 * Run with: npm run seed
 */

'use strict';

const { runMigrations, close } = require('./db');
const sitesRepo = require('./db/repositories/sites');

console.log('Seeding database with sweepstakes sites...\n');

runMigrations();

const sites = [
  { id: 'ace', name: 'Ace', url: 'https://www.ace.com', typical_sc: 0.3, typical_gc: 5000 },
  { id: 'acornfun', name: 'AcornFun', url: 'https://game.acornfun.com', typical_sc: 0, typical_gc: 1000 },
  { id: 'american-luck', name: 'American Luck', url: 'https://www.americanluck.com', typical_sc: 0.5, typical_gc: 5000 },
  { id: 'baba-casino', name: 'Baba Casino', url: 'https://play.babacasino.com', typical_sc: 0.3, typical_gc: 5000 },
  { id: 'bangcoins', name: 'BangCoins', url: 'https://www.bangcoins.com', typical_sc: 0, typical_gc: 5000 },
  { id: 'cashoomo', name: 'Cashoomo', url: 'https://www.cashoomo.com', typical_sc: 0.25, typical_gc: 1000 },
  { id: 'casino-click', name: 'Casino.click', url: 'https://casino.click', typical_sc: 0, typical_gc: 0 },
  { id: 'chanced', name: 'Chanced', url: 'https://www.chanced.com', typical_sc: 0.1, typical_gc: 5000 },
  { id: 'chipnwin', name: 'ChipNWin', url: 'https://chipnwin.com', typical_sc: 0.2, typical_gc: 3000 },
  { id: 'chumba', name: 'Chumba Casino', url: 'https://www.chumbacasino.com', typical_sc: 0, typical_gc: 200000 },
  { id: 'clubs-poker', name: 'Clubs Poker', url: 'https://play.clubs.poker', typical_sc: 0.2, typical_gc: 1000 },
  { id: 'coin-wizard-games', name: 'Coin Wizard Games', url: 'https://www.coinwizardgames.com', typical_sc: 0.2, typical_gc: 10000, reset_type: 'fixed_time' },
  { id: 'coolspin', name: 'CoolSpin', url: 'https://game.coolspinslot.com', typical_sc: 0.05, typical_gc: 5000 },
  { id: 'crashduel', name: 'CrashDuel', url: 'https://crashduel.com', typical_sc: 0.1, typical_gc: 100 },
  { id: 'crown-coins', name: 'Crown Coins Casino', url: 'https://crowncoinscasino.com', typical_sc: 1.0, typical_gc: 10000 },
  { id: 'dara-casino', name: 'Dara Casino', url: 'https://www.daracasino.com', typical_sc: 1.0, typical_gc: 15000 },
  { id: 'dimesweeps', name: 'DimeSweeps', url: 'https://www.dimesweeps.com', typical_sc: 0, typical_gc: 5000 },
  { id: 'firesevens', name: 'FireSevens', url: 'https://firesevens.com', typical_sc: 0, typical_gc: 700000 },
  { id: 'fortunarush', name: 'FortunaRush', url: 'https://fortunarush.com', typical_sc: 0.2, typical_gc: 500 },
  { id: 'fortune-wheelz', name: 'Fortune Wheelz', url: 'https://www.fortunewheelz.com', typical_sc: 0.2, typical_gc: 2000 },
  { id: 'fortunewins', name: 'Fortune Wins', url: 'https://www.fortunewins.com', typical_sc: 0.75, typical_gc: 5000 },
  { id: 'funrize', name: 'Funrize', url: 'https://www.funrize.com', typical_sc: 0.2, typical_gc: 5000 },
  { id: 'funzcity', name: 'FunzCity', url: 'https://www.funzcity.com', typical_sc: 0.25, typical_gc: 5000 },
  { id: 'gains', name: 'Gains', url: 'https://gains.com', typical_sc: 0.2, typical_gc: 10000 },
  { id: 'global-poker', name: 'Global Poker', url: 'https://play.globalpoker.com', typical_sc: 0.25, typical_gc: 7000 },
  { id: 'gold-machine', name: 'Gold Machine', url: 'https://www.goldmachine.com', typical_sc: 0.1, typical_gc: 500 },
  { id: 'gold-treasure', name: 'Gold Treasure', url: 'https://goldtreasurecasino.com', typical_sc: 0.3, typical_gc: 5000 },
  { id: 'golden-hearts', name: 'Golden Hearts', url: 'https://www.goldenheartsgames.com', typical_sc: 0.2, typical_gc: 10000 },
  { id: 'hello-millions', name: 'Hello Millions', url: 'https://www.hellomillions.com', typical_sc: 0.1, typical_gc: 1000 },
  { id: 'high5', name: 'High5 Casino', url: 'https://www.high5casino.com', typical_sc: 0, typical_gc: 0 },
  { id: 'jackpotrabbit', name: 'JackpotRabbit', url: 'https://www.jackpotrabbit.com', typical_sc: 0.2, typical_gc: 5000 },
  { id: 'jefebet', name: 'JefeBet', url: 'https://www.jefebet.com', typical_sc: 0.2, typical_gc: 2000 },
  { id: 'kickr', name: 'Kickr', url: 'https://www.kickr.com', typical_sc: 0.3, typical_gc: 0 },
  { id: 'lavish-luck', name: 'Lavish Luck', url: 'https://game.lavishluck.net', typical_sc: 0.1, typical_gc: 50000 },
  { id: 'legendz', name: 'Legendz', url: 'https://www.legendz.com', typical_sc: 0, typical_gc: 0 },
  { id: 'lonestar', name: 'LoneStar Casino', url: 'https://lonestarcasino.com', typical_sc: 0.4, typical_gc: 10000 },
  { id: 'luck-party', name: 'Luck Party', url: 'https://luckparty.com', typical_sc: 0.5, typical_gc: 5000 },
  { id: 'lucky-bits-vegas', name: 'Lucky Bits Vegas', url: 'https://www.luckybitsvegas.com', typical_sc: 0.3, typical_gc: 4000 },
  { id: 'luckyhands', name: 'Lucky Hands', url: 'https://luckyhands.com', typical_sc: 0.1, typical_gc: 10000 },
  { id: 'luckyland-casino', name: 'LuckyLand Casino', url: 'https://play.luckylandcasino.com', typical_sc: 0.13, typical_gc: 25000 },
  { id: 'luckyland', name: 'LuckyLand Slots', url: 'https://play.luckylandslots.com', typical_sc: 0.3, typical_gc: 7000 },
  { id: 'luckyrush', name: 'LuckyRush', url: 'https://www.luckyrush.io', typical_sc: 0, typical_gc: 7777 },
  { id: 'luckystake', name: 'LuckyStake', url: 'https://www.luckystake.com', typical_sc: 0.3, typical_gc: 0 },
  { id: 'lunaland-casino', name: 'LunaLand Casino', url: 'https://www.lunalandcasino.com', typical_sc: 0, typical_gc: 0 },
  { id: 'mcluck', name: 'McLuck', url: 'https://www.mcluck.com', typical_sc: 0.3, typical_gc: 0 },
  { id: 'megabonanza', name: 'MegaBonanza', url: 'https://www.megabonanza.com', typical_sc: 0.2, typical_gc: 1500 },
  { id: 'megaspinz', name: 'MegaSpinz', url: 'https://www.megaspinz.com', typical_sc: 0.1, typical_gc: 1000 },
  { id: 'modo', name: 'Modo', url: 'https://modo.us', typical_sc: 0.3, typical_gc: 5000 },
  { id: 'moneyfactory', name: 'MoneyFactory', url: 'https://www.themoneyfactory.com', typical_sc: 0.1, typical_gc: 20000 },
  { id: 'moozi', name: 'Moozi', url: 'https://moozi.com', typical_sc: 0.3, typical_gc: 3000 },
  { id: 'mr-goodwin', name: 'Mr. Goodwin', url: 'https://www.mrgoodwin.com', typical_sc: 0, typical_gc: 5000 },
  { id: 'myprize', name: 'MyPrize', url: 'https://myprize.us', typical_sc: 0, typical_gc: 5000 },
  { id: 'nolimitcoins', name: 'NoLimitCoins', url: 'https://www.nolimitcoins.com', typical_sc: 0, typical_gc: 5000 },
  { id: 'peakplay', name: 'PeakPlay', url: 'https://play.peakplay.com', typical_sc: 0, typical_gc: 200 },
  { id: 'playfame', name: 'PlayFame', url: 'https://www.playfame.com', typical_sc: 0.1, typical_gc: 600 },
  { id: 'pulsz', name: 'Pulsz', url: 'https://www.pulsz.com', typical_sc: 0.3, typical_gc: 1000 },
  { id: 'pulsz-bingo', name: 'Pulsz Bingo', url: 'https://www.pulszbingo.com', typical_sc: 0.3, typical_gc: 60 },
  { id: 'punt', name: 'Punt', url: 'https://www.punt.com', typical_sc: 0.3, typical_gc: 5000 },
  { id: 'realprize', name: 'RealPrize', url: 'https://www.realprize.com', typical_sc: 0.3, typical_gc: 5000 },
  { id: 'richsweeps', name: 'RichSweeps', url: 'https://www.richsweeps.com', typical_sc: 0.05, typical_gc: 5000 },
  { id: 'rolla', name: 'Rolla', url: 'https://www.rolla.com', typical_sc: 0.2, typical_gc: 6300 },
  { id: 'rollingriches', name: 'Rolling Riches', url: 'https://www.rollingriches.com', typical_sc: 0.2, typical_gc: 10000 },
  { id: 'roxymoxy', name: 'RoxyMoxy', url: 'https://roxymoxy.com', typical_sc: 0, typical_gc: 100000 },
  { id: 'rubysweeps', name: 'RubySweeps', url: 'https://play.rubysweeps.com', typical_sc: 0.1, typical_gc: 5000 },
  { id: 'scarletsands', name: 'ScarletSands', url: 'https://scarletsands.com', typical_sc: 0.1, typical_gc: 25000 },
  { id: 'scoop', name: 'Scoop', url: 'https://scoop.com', typical_sc: 0, typical_gc: 5000 },
  { id: 'scrooge', name: 'Scrooge', url: 'https://scrooge.casino', typical_sc: 0, typical_gc: 0 },
  { id: 'sheesh', name: 'Sheesh', url: 'https://sheeshcasino.com', typical_sc: 0.1, typical_gc: 5000 },
  { id: 'shuffle', name: 'Shuffle', url: 'https://shuffle.us', typical_sc: 0.1, typical_gc: 5000 },
  { id: 'sidepot', name: 'Sidepot', url: 'https://sidepot.us', typical_sc: 2.0, typical_gc: 5000 },
  { id: 'sixty6', name: 'Sixty6', url: 'https://sixty6.com', typical_sc: 0, typical_gc: 25000 },
  { id: 'smiles-casino', name: 'Smiles Casino', url: 'https://smilescasino.com', typical_sc: 0.1, typical_gc: 1000 },
  { id: 'speedsweeps', name: 'SpeedSweeps', url: 'https://www.speedsweeps.com', typical_sc: 0.05, typical_gc: 5000 },
  { id: 'spinblitz', name: 'SpinBlitz', url: 'https://www.spinblitz.com', typical_sc: 0.2, typical_gc: 5000 },
  { id: 'spinpals', name: 'SpinPals', url: 'https://www.spinpals.com', typical_sc: 0.3, typical_gc: 3000 },
  { id: 'spinquest', name: 'SpinQuest', url: 'https://www.spinquest.com', typical_sc: 1.0, typical_gc: 10000 },
  { id: 'spinsaga', name: 'SpinSaga', url: 'https://play.spinsagacasino.com', typical_sc: 0.25, typical_gc: 5000 },
  { id: 'spindoo', name: 'Spindoo', url: 'https://www.spindoo.us', typical_sc: 0.1, typical_gc: 500 },
  { id: 'spinfinite', name: 'Spinfinite', url: 'https://www.spinfinite.com', typical_sc: 0, typical_gc: 5000 },
  { id: 'sportzino', name: 'Sportzino', url: 'https://sportzino.com', typical_sc: 1.0, typical_gc: 20000 },
  { id: 'spree', name: 'Spree', url: 'https://spree.com', typical_sc: 0.3, typical_gc: 5000 },
  { id: 'stackr', name: 'Stackr Casino', url: 'https://stackrcasino.com', typical_sc: 0.3, typical_gc: 350000 },
  { id: 'stake', name: 'Stake.us', url: 'https://stake.us', typical_sc: 1.0, typical_gc: 10000 },
  { id: 'stormrush', name: 'StormRush', url: 'https://stormrush.com', typical_sc: 0.1, typical_gc: 10000 },
  { id: 'sweep-jungle', name: 'SweepJungle', url: 'https://sweepjungle.com', typical_sc: 0.1, typical_gc: 5000 },
  { id: 'sweepsla', name: 'SweepLasVegas', url: 'https://www.sweeplasvegas.com', typical_sc: 0.4, typical_gc: 450000 },
  { id: 'sweepnext', name: 'SweepNext', url: 'https://sweepnext.com', typical_sc: 0.2, typical_gc: 1000 },
  { id: 'sweepshark', name: 'SweepShark', url: 'https://sweepshark.com', typical_sc: 0.2, typical_gc: 0 },
  { id: 'sweepsroyal', name: 'SweepsRoyal', url: 'https://www.sweepsroyal.com', typical_sc: 0.05, typical_gc: 5000 },
  { id: 'sweepsusa', name: 'SweepsUSA', url: 'https://www.sweepsusa.com', typical_sc: 0.2, typical_gc: 1000 },
  { id: 'sweetsweeps', name: 'SweetSweeps', url: 'https://sweetsweeps.com', typical_sc: 0, typical_gc: 375 },
  { id: 'tao-fortune', name: 'Tao Fortune', url: 'https://www.taofortune.com', typical_sc: 0.2, typical_gc: 150000 },
  { id: 'thrillcoins', name: 'ThrillCoins', url: 'https://thrillcoins.com', typical_sc: 0.05, typical_gc: 5000 },
  { id: 'vikingriches', name: 'Viking Riches', url: 'https://vikingriches.com', typical_sc: 0.2, typical_gc: 500 },
  { id: 'wildworld', name: 'WildWorld', url: 'https://wildworldcasino.com', typical_sc: 0.1, typical_gc: 1000 },
  { id: 'winbonanza', name: 'WinBonanza', url: 'https://winbonanza.com', typical_sc: 0.2, typical_gc: 2000 },
  { id: 'wow-vegas', name: 'WoW Vegas', url: 'https://www.wowvegas.com', typical_sc: 0.1, typical_gc: 0 },
  { id: 'yaycasino', name: 'YayCasino', url: 'https://www.yaycasino.com', typical_sc: 0.25, typical_gc: 2500 },
  { id: 'yotta', name: 'Yotta', url: 'https://members.withyotta.com', typical_sc: 0, typical_gc: 0 },
  { id: 'zoot', name: 'Zoot', url: 'https://getzoot.us', typical_sc: 0.25, typical_gc: 5000 },
];

console.log(`Seeding ${sites.length} sweepstakes sites...`);
let created = 0;
for (const site of sites) {
  try {
    const existing = sitesRepo.getById(site.id);
    if (!existing) {
      sitesRepo.create({
        ...site,
        reset_type: site.reset_type || '24hr',
        active: true,
        bankroll: 0,
        pnl: 0,
      });
      created++;
    }
  } catch (err) {
    console.log(`  Error: ${site.name} - ${err.message}`);
  }
}

const total = sitesRepo.getAll().length;

console.log(`\n  Created: ${created} sites`);
console.log(`  Total in database: ${total}`);
console.log('\nSeed completed! Run "npm start" to launch the dashboard.');

close();
