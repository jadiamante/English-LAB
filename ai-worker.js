/**
 * ============================================================================
 *  ai-worker.js — Toda la inferencia PESADA de IA local corre acá adentro
 * ============================================================================
 * Antes, transformers.js/Kokoro corrían directo en el script principal — el
 * mismo hilo que dibuja la pantalla y atiende los toques/clicks. Un cálculo
 * largo (cargar un modelo, generar una respuesta, transcribir audio) podía
 * "congelar" TODA la interfaz mientras duraba: ni un botón respondía. En
 * celulares con poca potencia, eso se sentía como que la app se colgaba.
 *
 * Un Web Worker es un hilo aparte. Todo lo que pasa acá adentro NUNCA
 * bloquea la pantalla — por más que tarde, la app sigue respondiendo (se
 * ve lento, no roto). Esa es la única razón de que este archivo exista.
 *
 * Este worker NO sabe nada de la app en sí (no conoce botones, HTML, ni la
 * lógica de English Lab) — solo entiende pedidos por mensaje y contesta por
 * mensaje. El puente que arma esos pedidos vive en english-lab.html (buscar
 * "callAIWorker" en ese archivo).
 *
 * Protocolo de mensajes:
 *   Pedido:   { id, type, payload }
 *   Progreso: { id, type:'progress', payload:{ progress: 0-100 } }        (puede llegar varias veces)
 *   Éxito:    { id, type:'success', payload: <lo que corresponda> }       (una sola vez, al final)
 *   Error:    { id, type:'error', payload:{ message } }                  (una sola vez, en vez de success)
 * ============================================================================
 */

const LOCAL_MODEL_ID = "onnx-community/Qwen2.5-0.5B-Instruct";
const LOCAL_ASR_MODEL_ID = 'onnx-community/whisper-tiny.en';
const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-ONNX';

// Misma versión fijada que usa el resto de la app (ver el porqué en english-lab.html, cerca de
// loadTransformersLib) — mezclar versiones no confirmadas entre sí fue causa real de bugs antes.
let transformersModPromise = null;
function loadTransformersLib(){
  if(!transformersModPromise){
    transformersModPromise = import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1').then(mod=>{
      try{
        mod.env.backends.onnx.wasm.numThreads = 1;
        mod.env.backends.onnx.wasm.proxy = false;
      }catch(e){ /* seguimos con lo que venga por defecto */ }
      return mod;
    });
  }
  return transformersModPromise;
}

// Los tres modelos, cargados como mucho una vez cada uno, y reusados entre pedidos
let textGenerator = null;
let asrModel = null;
let kokoroTTS = null;

function reply(id, type, payload){
  self.postMessage({ id, type, payload });
}
function reportProgress(id, p){
  if(p && p.status === 'progress' && typeof p.progress === 'number'){
    reply(id, 'progress', { progress: p.progress });
  }
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try{
    let result;

    // ---------- Modelo de texto local (Qwen2.5-0.5B) ----------
    if(type === 'load-text-model'){
      const { pipeline } = await loadTransformersLib();
      textGenerator = await pipeline('text-generation', LOCAL_MODEL_ID, {
        dtype: 'q4',
        progress_callback: (p) => reportProgress(id, p),
      });
      result = { loaded: true };

    } else if(type === 'generate-text'){
      if(!textGenerator) throw new Error('El modelo de texto local no está cargado.');
      const output = await textGenerator(payload.chatMessages, { max_new_tokens: payload.maxNewTokens, do_sample: false });
      const last = output[0] && output[0].generated_text && output[0].generated_text.at(-1);
      result = { text: (last && last.content) || '' };

    // ---------- Transcriptor de voz local (Whisper tiny) ----------
    } else if(type === 'load-asr'){
      const { pipeline } = await loadTransformersLib();
      asrModel = await pipeline('automatic-speech-recognition', LOCAL_ASR_MODEL_ID, {
        dtype: 'q8',
        device: payload.hasWebGPU ? 'webgpu' : undefined,
        progress_callback: (p) => reportProgress(id, p),
      });
      result = { loaded: true };

    } else if(type === 'transcribe'){
      if(!asrModel) throw new Error('El transcriptor local no está cargado.');
      const audioData = new Float32Array(payload.audioBuffer);
      const out = await asrModel(audioData, { language: 'english', task: 'transcribe' });
      result = { text: ((out && out.text) || '').trim() };

    // ---------- Voz local Kokoro (síntesis de voz) ----------
    } else if(type === 'load-kokoro'){
      const { KokoroTTS } = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.0.1');
      kokoroTTS = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: 'q8',
        progress_callback: (p) => reportProgress(id, p),
      });
      let voices = null;
      try{ voices = typeof kokoroTTS.list_voices === 'function' ? kokoroTTS.list_voices() : (kokoroTTS.voices || null); }catch(e){}
      result = { loaded: true, voices };

    } else if(type === 'speak-kokoro'){
      if(!kokoroTTS) throw new Error('La voz Kokoro no está cargada.');
      let audio;
      try{
        audio = await kokoroTTS.generate(payload.text, { voice: payload.voice, speed: payload.speed });
      }catch(e){
        // "speed" solo confirmado en el paquete de Python — si esta versión de kokoro-js no lo
        // acepta, reintentamos sin ese parámetro en vez de dejar la voz muda.
        audio = await kokoroTTS.generate(payload.text, { voice: payload.voice });
      }
      // El audio crudo (Float32Array) viaja como ArrayBuffer TRANSFERIBLE — mucho más rápido que
      // copiarlo, y es el hilo principal el que arma el Blob/<audio> para reproducirlo (eso no
      // existe del lado de un worker).
      const samples = audio.audio;
      const buffer = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength);
      self.postMessage({ id, type: 'success', payload: { audioBuffer: buffer, samplingRate: audio.sampling_rate || 24000 } }, [buffer]);
      return; // ya contestamos a mano (con transferable) — no seguir al postMessage genérico de abajo
    }

    reply(id, 'success', result);
  }catch(err){
    reply(id, 'error', { message: (err && err.message) ? err.message : String(err) });
  }
};
