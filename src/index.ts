import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

/*
  This object defines the canvas that will display when your app initializes.
  It includes text, checkboxes, and a button.
  
  More information on these can be found in the reference docs.
  Canvas docs: https://developers.intercom.com/docs/references/canvas-kit/responseobjects/canvas/
  Components docs: https://developers.intercom.com/docs/references/canvas-kit/interactivecomponents/button/
*/
const initialCanvas = {
  canvas: {
    content: {
      components: [
        {
          type: 'text',
          id: 'department',
          text: 'This contact works in:',
          align: 'center',
          style: 'header',
        },
        {
          type: 'checkbox',
          id: 'departmentChoice',
          label: '',
          options: [
            {
              type: 'option',
              id: 'sales',
              text: 'Sales',
            },
            {
              type: 'option',
              id: 'operations',
              text: 'Operations',
            },
            {
              type: 'option',
              id: 'engineering',
              text: 'Engineering',
            },
          ],
        },
        {
          type: 'button',
          label: 'Submit',
          style: 'primary',
          id: 'submit_button',
          action: {
            type: 'submit',
          },
        },
      ],
    },
  },
};

// Root route - serves the HTML file
app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/*
  This is an endpoint that Intercom will POST HTTP request when a teammate inserts 
  the app into the inbox, or a new conversation is viewed.
*/
app.post('/initialize', (req: Request, res: Response) => {
  console.log('Initialize endpoint hit');
  res.send(initialCanvas);
});

/*
  When a submit action is taken in a canvas component, it will hit this endpoint.

  You can use this endpoint as many times as needed within a flow. You will need 
  to set up the conditions that will show it the required canvas object based on a 
  teammate's actions.

  In this example, if a user has clicked the initial submit button, it will show
  them the final submission canvas. If they click the refresh button to submit 
  another, it will show the initial canvas once again to repeat the process.
*/
app.post('/submit', (req: Request, res: Response) => {
  console.log('Submit endpoint hit with component_id:', req.body.component_id);
  console.log('Input values:', req.body.input_values);

  if (req.body.component_id === 'submit_button') {
    const department = req.body.input_values.departmentChoice;

    const finalCanvas = {
      canvas: {
        content: {
          components: [
            {
              type: 'text',
              id: 'thanks',
              text: `You chose: ${department}`,
              align: 'center',
              style: 'header',
            },
            {
              type: 'button',
              label: 'Submit another',
              style: 'primary',
              id: 'refresh_button',
              action: {
                type: 'submit',
              },
            },
          ],
        },
      },
    };
    res.send(finalCanvas);
  } else {
    res.send(initialCanvas);
  }
});

const listener = app.listen(PORT, () => {
  console.log(`Your app is listening on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to view your app`);
});
