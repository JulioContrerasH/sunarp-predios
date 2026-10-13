// Configuración de la API de predios.
// En producción: la clave demo solo sirve para vista previa limitada;
// el acceso completo va con la clave del usuario (login).
window.SUNARP_CONFIG = {
  // Datos completos (1 891 distritos) servidos desde Cloudflare R2
  R2_URL: 'https://pub-7556b8c9db564d82aa1c9b5d2ec48e60.r2.dev',
  // Teselas estáticas (PMTiles en R2): se activa cuando estén subidas
  PMTILES_URL: '',
  // API en deep: solo para desarrollo (si se activa, Chrome pedirá permiso de red local)
  API_URL: '',
  API_KEY: '',
  LIMITE_MAPA: 30000
};
