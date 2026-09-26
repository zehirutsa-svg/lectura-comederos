# Configurar el Google Sheet (una sola vez, ~10 minutos)

Todo se hace con la cuenta **zehirutsa@gmail.com**, desde una computadora.

## 1. Crear la planilla

1. Entrar a <https://sheets.google.com> con zehirutsa@gmail.com.
2. Crear una hoja en blanco y ponerle de nombre **Lectura de Comederos**.

## 2. Pegar el script

1. En la planilla: menú **Extensiones → Apps Script**. Se abre el editor en otra pestaña.
2. Arriba a la izquierda, cambiar "Proyecto sin título" por **Lectura de Comederos**.
3. Borrar todo lo que aparece en el archivo `Código.gs`.
4. Pegar el contenido completo de `apps-script/Code.gs` (de esta carpeta).
5. En las primeras líneas, cambiar `'CAMBIAR'` por el **código de administrador** que quieras,
   entre comillas, de 4 a 8 números. Ejemplo: `const PIN_ADMIN = '4821';`
   Ese código es el que vas a usar en tu teléfono para corregir días anteriores.
6. Guardar (ícono del disquete, o Ctrl+S).

## 3. Preparar la planilla

1. Arriba, en la lista de funciones, elegir **configurar** y apretar **▶ Ejecutar**.
2. Google pide permiso la primera vez:
   - "Revisar permisos" → elegir zehirutsa@gmail.com.
   - Si aparece "Google no verificó esta app": **Configuración avanzada → Ir a Lectura de
     Comederos (no seguro)**. Es normal: el script es tuyo, no de una empresa externa.
   - **Permitir**. Pide acceso a la planilla, a mandar mails (el aviso) y a ejecutarse solo
     cada 10 minutos (para revisar si hay que mandar el aviso).
3. Al terminar, la planilla tiene 4 pestañas: **Planilla**, **Registro**, **Corrales** y **Datos**,
   con los corrales 1 a 12 cargados.

## 4. Publicar el script para que lo usen los teléfonos

1. En el editor de Apps Script: botón azul **Implementar → Nueva implementación**.
2. En el engranaje de "Seleccionar tipo", elegir **Aplicación web**.
3. Completar:
   - Descripción: `Lectura de Comederos`
   - Ejecutar como: **Yo (zehirutsa@gmail.com)**
   - Quién tiene acceso: **Cualquier usuario**  ← importante, si no los teléfonos no pueden guardar
4. **Implementar**. Copiar la **URL de la aplicación web** (empieza con
   `https://script.google.com/macros/s/...` y termina en `/exec`).
5. **Pasarle esa URL a Claude**, que la pone en la app y la publica.

> "Cualquier usuario" no significa que cualquiera vea la planilla: la planilla sigue siendo
> privada. Solo permite que la app mande scores a esa dirección, con las reglas del script
> (el operario solo puede tocar el día de hoy; corregir otros días exige el código).

## Si más adelante se cambia el script

Después de pegar una versión nueva del script: **Implementar → Gestionar implementaciones →
✏️ (editar) → Versión: Nueva versión → Implementar**. Así la URL sigue siendo la misma y no hay
que tocar la app. (Si se hace "Nueva implementación" en cambio, sale una URL nueva.)

## Cambiar el código de administrador

Editar `PIN_ADMIN` en el script, guardar y publicar una versión nueva (paso anterior). En tu
teléfono: Menú → Salir del modo administrador → Entrar con código, con el código nuevo.

## Cambiar a quién llega el aviso

Editar `EMAIL_AVISO` (varios mails separados por coma, ej. `'a@gmail.com, b@gmail.com'`),
guardar y publicar una versión nueva.

## Qué hay en cada pestaña

- **Planilla**: como el Excel de siempre — corrales en filas, días en columnas, `4 (-2%)` en cada
  celda, con el mismo color que los botones de la app. Se rearma sola con cada carga; no editar a mano.
- **Registro**: cada cambio que llegó (carga, modificación, borrado), con quién, a qué hora del
  teléfono y si se aplicó o se rechazó. Nunca se borra nada acá.
- **Corrales**: la lista de corrales y si están en uso (se cambia desde la app, modo administrador).
- **Datos**: el valor vigente de cada corral y día, que es lo que leen los teléfonos. No editar a mano.
