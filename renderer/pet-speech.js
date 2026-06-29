(function exposePetSpeech(root) {
  const CHATTER = {
    sit: ['坐久啦，起来动动～', '记得喝口水哦', '伸个懒腰吧！', '抬头远眺一下眼睛'],
    care: ['今天也辛苦啦', '别太累，我陪着你', '深呼吸，放松一下～', '你已经很棒啦'],
    cute: ['{name}在偷看你～', '摸摸我嘛', '嘿，被我发现摸鱼', '哼哧哼哧…'],
  };

  function timeGreeting(date = new Date()) {
    const h = date.getHours();
    if (h < 5) return ['夜深了，早点睡呀', '别熬太晚哦'];
    if (h < 11) return ['早上好呀！', '新的一天，加油！'];
    if (h < 14) return ['中午啦，吃饭了吗', '午休一下吧～'];
    if (h < 18) return ['下午好～', '喝杯茶提提神？'];
    if (h < 23) return ['晚上好呀', '忙完了吗？歇会儿'];
    return ['夜深了，早点睡呀', '别熬太晚哦'];
  }

  function pickChatter(name, random = Math.random, date = new Date()) {
    const pools = [CHATTER.sit, CHATTER.care, CHATTER.cute, timeGreeting(date)];
    const pool = pools[Math.floor(random() * pools.length)];
    const msg = pool[Math.floor(random() * pool.length)];
    return msg.replace(/\{name\}/g, name);
  }

  root.PetSpeech = { pickChatter, timeGreeting };
})(window);
