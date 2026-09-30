// Only Mini App links opt into English. Bot setup links keep their original copy.
const ENGLISH_COPY = Object.freeze({
  "Outline ကို ဖွင့်ပေးနေပါတယ်…": "Opening Outline…",
  "Outline မပွင့်ရင် အောက်ကခလုတ်ကို နှိပ်ပေးပါ။": "If Outline doesn’t open, tap below.",
  "Outline ဖွင့်ဖို့ ခွင့်ပြုပြီး Add → Connect ကိုနှိပ်ပေးပါ။": "Allow Outline to open, then tap Add and Connect.",
  "မပွင့်ရင် ဒီစာမျက်နှာကို Safari / Chrome နဲ့ ဖွင့်ကြည့်ပေးပါ။": "If needed, open this page in Safari or Chrome.",
  "VPN key ကို ကူးပြီး Outline ထဲ ထည့်လို့လည်း ရပါတယ်။ Link က 10 မိနစ်အတွင်း သက်တမ်းကုန်ပါတယ်။ မမျှဝေပေးပါနဲ့။": "You can also copy your VPN key into Outline. This link expires in 10 minutes. Keep it private.",
  "Outline ဖွင့်ဖို့ JavaScript ကို ဖွင့်ပေးပါ။": "Enable JavaScript to open Outline.",
  "ဒီ link က သက်တမ်းကုန်သွားပါပြီ။ My VPN မှာ Connect ကို ပြန်နှိပ်ပေးပါ။": "This link has expired. Tap Connect in My VPN for a new link.",
  "Outline မပွင့်သေးပါဘူး။ VPN key ကို ကူးပြီး Outline ထဲ ထည့်ပေးပါ။": "Couldn’t open Outline. Copy your VPN key into Outline.",
  "Outline မပွင့်ရင် Open Outline ကိုနှိပ်ပေးပါ။ VPN key ကို ကူးထည့်လို့လည်း ရပါတယ်။": "Tap Open Outline to try again, or copy your VPN key into Outline.",
  "VPN key ကူးပြီးပါပြီ။ Outline ထဲ ထည့်ပြီး Add → Connect ကိုနှိပ်ပေးပါ။": "VPN key copied. Paste it into Outline, then tap Add and Connect.",
  "ကူးလို့မရသေးပါဘူး။ Copy VPN Key ကို ပြန်နှိပ်ပေးပါ။": "Couldn’t copy your VPN key. Tap Copy VPN key to try again.",
  "Safari က မေးလာရင် Open ကိုနှိပ်ပေးပါ။ မပွင့်ရင် Open Outline ကိုနှိပ်ပြီး Add → Connect ကိုနှိပ်ပေးပါ။": "Tap Open when Safari asks. Then tap Add and Connect in Outline.",
  "Open Outline ကိုနှိပ်ပေးပါ။ Chrome က မေးလာရင် Outline ကိုရွေးပြီး Add → Connect ကိုနှိပ်ပေးပါ။": "Tap Open Outline. Choose Outline when Chrome asks, then tap Add and Connect.",
  "Outline ဖွင့်ဖို့ ခွင့်ပြုပေးပါ။ Windows က app ရွေးခိုင်းရင် Outline ကိုရွေးပြီး key ထည့်ပေးပါ။ ပြီးရင် Connect ကိုနှိပ်ပေးပါ။": "Allow Outline to open. Choose Outline if Windows asks, add your VPN key, then tap Connect.",
  "Mac မှာ Outline ဖွင့်ဖို့ ခွင့်ပြုပေးပါ။ Key ထည့်ပြီး Connect ကိုနှိပ်ပေးပါ။": "Allow Outline to open on your Mac. Add your VPN key, then tap Connect.",
  "ခဏစောင့်ပြီးမှ Connect ကို ပြန်နှိပ်ပေးပါ။": "Wait a moment before tapping Connect again.",
  "My VPN မှာ Connect ကို ပြန်နှိပ်ပေးပါ။": "Tap Connect in My VPN to try again.",
  "ဒီ link က သုံးလို့မရတော့ပါဘူး။ My VPN မှာ Connect ကို ပြန်နှိပ်ပေးပါ။": "This link is no longer available. Tap Connect in My VPN for a new link.",
  "Connect ကို အခုဖွင့်လို့မရသေးပါဘူး။ ခဏနေရင် My VPN မှာ ပြန်စမ်းကြည့်ပေးပါ။": "Couldn’t open Connect. Try again in My VPN in a moment.",
  "Copy VPN Key": "Copy VPN key",
});

function connectCopy(value, language = "my") {
  return language === "en" ? ENGLISH_COPY[value] || value : value;
}

module.exports = { connectCopy };
