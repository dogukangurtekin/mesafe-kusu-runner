/*
  Mesafe Kuşu - Arduino kodu (HC-SR04 ultrasonik mesafe sensörü) - kararlı sürüm

  Bağlantı:
    HC-SR04 VCC  -> Arduino 5V
    HC-SR04 GND  -> Arduino GND
    HC-SR04 TRIG -> Arduino D9
    HC-SR04 ECHO -> Arduino D10

  Ne yapar?
    - Her 30 ms'de bir ölçüm yapar (saniyede ~33 değer): el hareketi gecikmesiz izlenir.
    - Son 3 ölçümün ORTANCASINI (medyan) gönderir: tek seferlik hatalı/zıplayan
      okumalar oyuna hiç ulaşmaz. Ek yumuşatma ve hassasiyet ayarı oyun sayfasındadır
      ("Hassasiyet" kaydırıcısı).
    - Seri porta satır başına tek bir sayı yazar (örn. 23.4). Yankı yoksa (el menzil
      dışında) -1 yazar; böylece oyun "Arduino bağlı ama el yok" ile "kablo koptu"
      durumunu ayırt eder.
    - Sensör kablosu çıkarsa ya da sensör takılı değilse de -1 gönderir, kart
      susmaz; oyun bağlantıyı koparmış saymaz.

  Kullanım:
    1) Kodu karta yükleyin, ardından Arduino IDE'nin Seri Monitörünü KAPATIN
       (açık kalırsa tarayıcı bağlanamaz).
    2) Oyun sayfasında "Arduino'yu bağla"ya basıp kartı seçin. Baud: 115200.
    3) Kart USB'ye takılınca kendini yeniden başlatır; ilk 1-2 saniye veri gelmeyebilir.
*/

const int TRIG_PIN = 9;
const int ECHO_PIN = 10;

const unsigned long OLCUM_ARALIGI_MS = 30;            // iki ölçüm arası (yakın mesafede 30 ms güvenli; saniyede ~33 ölçüm)
const unsigned long YANKI_ZAMAN_ASIMI_US = 12000UL;   // ~2 m; daha uzağı oyun için gereksiz (yankı gelmezse hızlı vazgeçer)
const float MIN_CM = 2.0;                             // HC-SR04'ün güvenilir alt sınırı
const float MAX_CM = 200.0;
const int PENCERE = 3;                                // medyan penceresi (tek sayı olmalı); 3 = düşük gecikme, tek sıçramaları eler

float pencere[PENCERE];
int pencereSayisi = 0;       // pencerede geçerli kaç ölçüm var
int pencereIndeks = 0;
int ardArdaBos = 0;          // art arda kaç ölçümde yankı gelmedi
int supheliSayac = 0;        // art arda kaç ölçüm ani sıçrama gibi göründü
unsigned long sonOlcum = 0;

void setup() {
  Serial.begin(115200);
  // Leonardo / Micro gibi USB'si yerleşik kartlar için: port açılana kadar en fazla 2 sn bekle.
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000) { }

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);
  delay(100);                // sensör açılışta otursun
}

// Tek ölçüm: santimetre döndürür, yankı yoksa ya da aralık dışıysa -1.
float olcCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(4);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long sure = pulseIn(ECHO_PIN, HIGH, YANKI_ZAMAN_ASIMI_US);
  if (sure == 0) return -1;                      // yankı gelmedi
  float cm = sure * 0.01715;                     // ses: 0.0343 cm/us, gidiş-dönüş => /2
  if (cm < MIN_CM || cm > MAX_CM) return -1;
  return cm;
}

// Penceredeki geçerli ölçümlerin ortancası (en fazla 5 eleman: ekleme sıralaması yeterli).
float ortanca() {
  float kopya[PENCERE];
  for (int i = 0; i < pencereSayisi; i++) kopya[i] = pencere[i];
  for (int i = 1; i < pencereSayisi; i++) {
    float v = kopya[i];
    int j = i - 1;
    while (j >= 0 && kopya[j] > v) { kopya[j + 1] = kopya[j]; j--; }
    kopya[j + 1] = v;
  }
  return kopya[pencereSayisi / 2];
}

void loop() {
  unsigned long simdi = millis();
  if (simdi - sonOlcum < OLCUM_ARALIGI_MS) return;   // delay() yerine zamanlayıcı: seri hat hep akıcı
  sonOlcum = simdi;

  float cm = olcCm();

  // Ani sıçrama koruması: pencere doluyken son ortancadan 40 cm'den fazla uzak TEK bir ölçüm
  // sensör parazitidir; üst üste 2 kez gelirse gerçek hareket sayılır.
  if (cm > 0 && pencereSayisi >= 3) {
    float onceki = ortanca();
    if (abs(cm - onceki) > 40.0) {
      supheliSayac++;
      if (supheliSayac < 2) cm = -2;                  // bu ölçümü yok say (boşluk sayılmaz)
    } else {
      supheliSayac = 0;
    }
  }

  if (cm == -2) {
    if (pencereSayisi > 0) Serial.println(ortanca(), 1);
    return;
  }

  if (cm > 0) {
    supheliSayac = 0;
    ardArdaBos = 0;
    pencere[pencereIndeks] = cm;
    pencereIndeks = (pencereIndeks + 1) % PENCERE;
    if (pencereSayisi < PENCERE) pencereSayisi++;
    Serial.println(ortanca(), 1);                    // örn. 23.4
  } else {
    ardArdaBos++;
    if (ardArdaBos >= 3) {
      // El menzilden çıktı ya da sensör yok: pencereyi temizle, "-1" ile haber ver.
      pencereSayisi = 0;
      pencereIndeks = 0;
      Serial.println(-1);
    } else if (pencereSayisi > 0) {
      Serial.println(ortanca(), 1);                  // kısa süreli tek tük kayıpta son değeri koru
    }
  }
}
