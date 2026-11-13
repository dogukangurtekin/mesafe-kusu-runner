/* Mesafe Kuşu - bölüm verileri. params: target = geçilecek engel sayısı, speed = px/sn, gap = geçit yüksekliği, spacing = engeller arası px.
   Son görev "Sonsuz Oyun"dur (hidden): bölüm listesinde kart olmaz, mod seçim ekranından açılır. */
(function () {
    'use strict';
    var NAMES = [
        ['Isınma Uçuşu', 'Isınma'], ['Bulut Geçidi', 'Ritim'], ['Dar Boğaz', 'Denge'], ['Taş Koridor', 'Hassasiyet'], ['Rüzgârlı Vadi', 'Hız'],
        ['Kayalık Zirve', 'Odak'], ['Keskin Dönüşler', 'Refleks'], ['Fırtına Hattı', 'Dayanıklılık'], ['Ustalar Geçidi', 'Usta'], ['Büyük Final', 'Final']
    ];
    var tasks = [];
    for (var n = 1; n <= 10; n++) {
        var gap = 235 - n * 11;
        tasks.push({
            id: 'mk-' + n,
            title: NAMES[n - 1][0],
            topic: NAMES[n - 1][1],
            summary: (5 + n) + ' engeli geç, elinin mesafesiyle ya da Boşluk tuşuyla kuşu yönet.',
            age: 8, level: n <= 3 ? 'Kolay' : (n <= 7 ? 'Orta' : 'Zor'), xp: 10 + n * 5,
            brief: (5 + n) + ' taş engelin geçidinden uç. 3 canın var; ne kadar az can kaybedersen o kadar çok yıldız kazanırsın.',
            tip: 'Elini sensöre yaklaştır: kuş aşağı iner, uzaklaştır: yukarı çıkar. Boşluk tuşunda basılı tut: yukarı, bırak: aşağı.',
            params: { target: 5 + n, speed: 170 + n * 14, gap: gap, spacing: 360 - n * 8 }
        });
    }
    tasks.push({
        id: 'mk-endless', hidden: true, noProgress: true, endless: true,
        title: 'Sonsuz Oyun', topic: 'Sonsuz', summary: 'Engeller bitmez; hızlandıkça zorlaşır.',
        age: 8, level: 'Zor', xp: 0,
        brief: 'Sonsuz Oyun: engeller bitmez, kuş her engelde biraz daha hızlanır. Yanana kadar uç, puanını rekor yap!',
        tip: 'Her engel puan getirir, hızlandıkça puan da artar. Yıldız toplarsan ekstra puan kazanırsın.',
        params: { target: Infinity, speed: 175, gap: 240, spacing: 370 }
    });
    window.MK_TASKS = tasks;
})();
