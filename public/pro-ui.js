/* Pro UI: простой вход + приветствие. Логику сервера не трогает. */
(function(){
  function hello(){
    var h=new Date().getHours();
    return h<5?"Доброй ночи":h<12?"Доброе утро":h<18?"Добрый день":"Добрый вечер";
  }
  function toast(html){
    var d=document.createElement("div");d.className="pro-welcome";d.innerHTML=html;document.body.appendChild(d);
    requestAnimationFrame(function(){requestAnimationFrame(function(){d.classList.add("show")})});
    setTimeout(function(){d.classList.remove("show");setTimeout(function(){d.remove()},600)},3600);
  }
  function auth(){
    var id=document.getElementById("identifier"),pw=document.getElementById("password");
    if(!id||!pw)return;
    var p=document.querySelector(".auth-card .brand p");
    if(p)p.textContent=hello()+"! Войдите, чтобы продолжить";
    id.placeholder="username";id.setAttribute("autocapitalize","none");id.setAttribute("autocorrect","off");id.setAttribute("spellcheck","false");
    id.addEventListener("input",function(){var v=id.value.replace(/^@+/,"").replace(/\s+/g,"");if(v!==id.value)id.value=v});
    pw.placeholder="Пароль";
    var w=document.createElement("div");w.className="pwrap";pw.parentNode.insertBefore(w,pw);w.appendChild(pw);
    var eye=document.createElement("button");eye.type="button";eye.setAttribute("aria-label","Показать пароль");eye.innerHTML='<i class="fa-regular fa-eye"></i>';
    eye.textContent="👁";
    eye.onclick=function(){var s=pw.type==="password";pw.type=s?"text":"password";eye.style.color=s?"#2a7fff":""};
    w.appendChild(eye);
    [id,pw].forEach(function(el){el.addEventListener("keydown",function(e){if(e.key==="Enter")window.submitAuth()})});
    var box=document.getElementById("acceptTermsBox"),row=box&&box.closest("label");
    if(row){
      var t=document.createElement("div");t.className="terms-line";
      t.innerHTML='Продолжая, вы принимаете <a href="#" onclick="openLegalModal(\'terms\');return false;">условия</a> и <a href="#" onclick="openLegalModal(\'privacy\');return false;">политику конфиденциальности</a>.';
      row.parentNode.replaceChild(t,row);
      var hid=document.createElement("input");hid.type="checkbox";hid.id="acceptTermsBox";hid.checked=true;hid.style.display="none";t.appendChild(hid);
    }
    var hint=document.querySelector("#authForm .hint");
    if(hint)hint.textContent="Имя: латиница, цифры и _. Пароль: от 4 символов.";
  }
  function chat(){
    try{
      if(sessionStorage.getItem("proHello"))return;
      if(!localStorage.getItem("zumoWelcomeAny"))return; /* на новом устройстве вместо плашки — приветственный тур (welcome.js) */
      sessionStorage.setItem("proHello","1");
      setTimeout(function(){toast(hello()+"! Добро пожаловать в <b>Zumo</b>")},700);
    }catch(e){}
  }
  document.addEventListener("DOMContentLoaded",function(){document.getElementById("authForm")?auth():chat()});
})();
